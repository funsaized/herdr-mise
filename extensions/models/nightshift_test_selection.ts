/** Compile approved test names into bounded runner calls, retaining legacy plans. */
import { z } from "npm:zod@4.4.3";
import { rustTestArguments } from "./rust_test_receipt.ts";
import { sourceDigest } from "./test_receipt.ts";
import { subjectRoot } from "./subject_root.ts";

const Selection = z
  .object({
    runner: z.enum(["node", "vitest", "playwright", "rust"]),
    selector: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\r\n\0]+$/),
    target: z.enum(["lib", "integration"]).optional(),
    targetName: z
      .string()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/)
      .max(64)
      .optional(),
  })
  .strict();
const Arguments = z.object({
  workItem: z.string().regex(/^[1-9][0-9]{0,15}$/),
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  subjectRoot: z.string().min(1),
  expectedGitHead: z.string().regex(/^[0-9a-f]{40}$/),
});
type Args = z.infer<typeof Arguments>;
type Context = {
  repoDir: string;
  modelType: unknown;
  modelId: string;
  signal?: AbortSignal;
  definitionRepository: {
    findByNameGlobal(name: string): Promise<{
      definition: { id: string };
      type: { normalized: string };
    } | null>;
  };
  dataRepository: {
    findAllForModel(
      type: unknown,
      id: string,
    ): Promise<Array<{ name: string; version: number }>>;
    getContent(
      type: unknown,
      id: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
  writeResource(
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ): Promise<{ name: string }>;
};

export function compileTestSelection(value: unknown, args: Args) {
  if (value === undefined) return [];
  const selections = z.array(Selection).min(1).max(10).parse(value);
  return selections.map((selection, index) => {
    const identity = {
      subjectRoot: args.subjectRoot,
      expectedGitHead: args.expectedGitHead,
    };
    const common = {
      id: String(index),
      modelName: `nightshift-test-${args.workItem}-${args.runId}-${index}`,
    };
    if (selection.runner === "rust") {
      if (!selection.target) throw new Error("Rust selection requires target");
      const inputs = {
        ...identity,
        target: selection.target,
        targetName: selection.targetName,
        testName: selection.selector,
      };
      return {
        ...common,
        modelType: "@funsaized/herdr-mise-rust",
        globalArgs: {},
        inputs,
        expectedArgv: ["cargo", ...rustTestArguments(inputs)],
      };
    }
    if (selection.target || selection.targetName)
      throw new Error("Rust target fields are invalid for npm selections");
    const exact = selection.selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const script =
      selection.runner === "node"
        ? "test:unit"
        : selection.runner === "vitest"
          ? "test"
          : "test:visual";
    const reporter =
      selection.runner === "node"
        ? "node-tap"
        : selection.runner === "vitest"
          ? "vitest-json"
          : "playwright-json";
    const scriptArgs =
      selection.runner === "node"
        ? [`--test-name-pattern=^${exact}$`]
        : selection.runner === "vitest"
          ? [`--testNamePattern=^${exact}$`]
          : ["--grep", `${exact}$`];
    return {
      ...common,
      modelType: "@funsaized/npm/project",
      globalArgs: {
        projectDir: selection.runner === "vitest" ? "client" : ".",
        allowedScripts: [script],
        lifecycleScripts: "deny",
        requireCleanGit: false,
        configPolicy: "project",
        strictToolchain: false,
        environment: {},
        defaultTimeoutMs: 900000,
      },
      inputs: { ...identity, script, reporter, args: scriptArgs },
      expectedArgv: [
        "npm",
        "run",
        script,
        "--",
        ...scriptArgs,
        reporter === "node-tap" ? "--test-reporter=tap" : "--reporter=json",
      ],
    };
  });
}

async function stored(context: Context, name: string) {
  const metadata = (
    await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    )
  )
    .filter((record) => record.name === name)
    .sort((a, b) => b.version - a.version)[0];
  if (!metadata) throw new Error(`Missing factory record: ${name}`);
  const bytes = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    name,
    metadata.version,
  );
  if (!bytes) throw new Error(`Unreadable factory record: ${name}`);
  return {
    version: metadata.version,
    attributes: JSON.parse(new TextDecoder().decode(bytes)),
  };
}

export function requireApprovedPlan(
  workItem: string,
  state: Record<string, unknown>,
  plan: { version: number; attributes: Record<string, unknown> },
  review: Record<string, unknown>,
  approval: Record<string, unknown>,
) {
  const cycles = state.cycles as Record<string, number> | undefined;
  if (
    state.workItem !== workItem ||
    state.stageId !== "building" ||
    state.status !== "active" ||
    plan.attributes.workItem !== workItem ||
    review.workItem !== workItem ||
    approval.workItem !== workItem ||
    approval.decision !== "approved" ||
    approval.gateId !== "plan-approval" ||
    approval.stageId !== "plan-review" ||
    !Number.isInteger(cycles?.planning) ||
    !Number.isInteger(cycles?.["plan-review"]) ||
    plan.attributes.name !== "plan" ||
    plan.attributes.stageId !== "planning" ||
    review.name !== "plan-review" ||
    review.stageId !== "plan-review" ||
    approval.cycle !== cycles?.["plan-review"] ||
    review.subjectVersion !== plan.version ||
    review.cycle !== cycles?.["plan-review"] ||
    plan.attributes.cycle !== cycles?.planning
  )
    throw new Error(
      "Test selection requires the current approved plan in the building stage",
    );
  const times = [
    plan.attributes.recordedAt,
    review.recordedAt,
    approval.decidedAt,
  ].map((value) => Date.parse(String(value)));
  if (
    times.some((value) => !Number.isFinite(value)) ||
    times[0] > times[1] ||
    times[1] > times[2]
  )
    throw new Error("Plan or review changed after approval");
}

export const extension = {
  type: "@swamp/software-factory",
  resources: {
    testPlan: {
      description: "Approved test selection and exact runner calls",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "30d",
      garbageCollection: 100,
    },
    testEvidence: {
      description:
        "Verified receipts matching the approved selection and current source",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "30d",
      garbageCollection: 100,
    },
  },
  methods: [
    {
      prepare_test_selection: {
        description:
          "Read the current approved factory plan and compile its bounded test selection",
        arguments: Arguments,
        execute: async (args: Args, context: Context) => {
          const [state, plan, review, approval] = await Promise.all([
            stored(context, `state-${args.workItem}`),
            stored(context, `artifact-${args.workItem}-plan`),
            stored(context, `artifact-${args.workItem}-plan-review`),
            stored(context, `approval-${args.workItem}-plan-approval`),
          ]);
          requireApprovedPlan(
            args.workItem,
            state.attributes,
            plan,
            review.attributes,
            approval.attributes,
          );
          const payload = z
            .object({ testSelection: z.unknown().optional() })
            .passthrough()
            .parse(plan.attributes.payload);
          const entries = compileTestSelection(payload.testSelection, args);
          const handle = await context.writeResource("testPlan", "test-plan", {
            ...args,
            preparedAt: new Date().toISOString(),
            planVersion: plan.version,
            mode: entries.length ? "receipts" : "legacy-transcript",
            entries,
          });
          return { dataHandles: [handle] };
        },
      },
    },
    {
      record_test_results: {
        description:
          "Reject missing, stale or mismatched receipts before recording test evidence",
        arguments: Arguments,
        execute: async (args: Args, context: Context) => {
          const plan = (await stored(context, "test-plan")).attributes;
          if (
            plan.runId !== args.runId ||
            plan.workItem !== args.workItem ||
            plan.expectedGitHead !== args.expectedGitHead ||
            plan.subjectRoot !== args.subjectRoot
          )
            throw new Error(
              "Test plan belongs to a different build invocation",
            );
          const [state, approvedPlan, review, approval] = await Promise.all([
            stored(context, `state-${args.workItem}`),
            stored(context, `artifact-${args.workItem}-plan`),
            stored(context, `artifact-${args.workItem}-plan-review`),
            stored(context, `approval-${args.workItem}-plan-approval`),
          ]);
          requireApprovedPlan(
            args.workItem,
            state.attributes,
            approvedPlan,
            review.attributes,
            approval.attributes,
          );
          if (approvedPlan.version !== plan.planVersion)
            throw new Error("Approved plan changed during testing");
          const entries = z
            .array(
              z.object({
                modelName: z.string(),
                modelType: z.string(),
                expectedArgv: z.array(z.string()),
              }),
            )
            .parse(plan.entries);
          const receipts: Record<string, unknown>[] = [];
          for (const entry of entries) {
            const model = await context.definitionRepository.findByNameGlobal(
              entry.modelName,
            );
            if (!model || model.type.normalized !== entry.modelType)
              throw new Error(
                "Selected test model is missing or has changed type",
              );
            const bytes = await context.dataRepository.getContent(
              model.type,
              model.definition.id,
              "verified-test-result",
            );
            if (!bytes)
              throw new Error("Selected test has no stored verified receipt");
            receipts.push(JSON.parse(new TextDecoder().decode(bytes)));
          }
          const root = await subjectRoot(context.repoDir, args.subjectRoot);
          const identity = await new Deno.Command("git", {
            args: ["rev-parse", "HEAD"],
            cwd: root,
            env: {
              PATH: Deno.env.get("PATH") ?? "",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
            },
            clearEnv: true,
            signal: context.signal,
            stdout: "piped",
            stderr: "piped",
          }).output();
          if (
            !identity.success ||
            new TextDecoder().decode(identity.stdout).trim() !==
              args.expectedGitHead
          )
            throw new Error("Subject HEAD changed during testing");
          const digest = await sourceDigest(root, context.signal);
          for (const [index, receipt] of receipts.entries()) {
            const counts = receipt.counts as
              | { passed?: number; failed?: number }
              | undefined;
            if (
              receipt.executionStatus !== "succeeded" ||
              receipt.exitCode !== 0 ||
              !receipt.verifiedAt ||
              receipt.gitHeadBefore !== args.expectedGitHead ||
              receipt.gitHeadAfter !== args.expectedGitHead ||
              receipt.sourceDigestBefore !== digest ||
              receipt.sourceDigestAfter !== digest ||
              receipt.subjectRoot !== root ||
              !Number.isFinite(Date.parse(String(receipt.startedAt))) ||
              !(
                Date.parse(String(receipt.startedAt)) >=
                Date.parse(String(plan.preparedAt))
              ) ||
              !counts?.passed ||
              counts.failed !== 0 ||
              JSON.stringify(receipt.argv) !==
                JSON.stringify(entries[index].expectedArgv)
            )
              throw new Error(
                "Selected test receipt is stale or does not prove the approved command",
              );
          }
          const handle = await context.writeResource(
            "testEvidence",
            "test-evidence",
            {
              ...args,
              sourceDigest: digest,
              mode: plan.mode,
              receipts: receipts.map((receipt, index) => ({
                ...receipt,
                modelName: entries[index].modelName,
              })),
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
