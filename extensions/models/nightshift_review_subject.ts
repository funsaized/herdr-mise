/** Bind each review round to source, trusted policy, and its routed lanes. */
import { z } from "npm:zod@4.4.3";
import {
  LANE_SKILLS,
  type Lane,
  LaneReview,
  normalizeReviews,
  routeLanes,
} from "./nightshift_review.ts";
import { sourceDigest } from "./test_receipt.ts";
import { subjectRoot } from "./subject_root.ts";

const Arguments = z.object({
  workItem: z.string().regex(/^[1-9][0-9]{0,15}$/),
  runId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  phase: z.enum(["plan", "code"]),
  subjectRoot: z.string().min(1),
  subject: z.record(z.string(), z.unknown()),
  previousFindings: z.array(z.record(z.string(), z.unknown())).default([]),
});
type Args = z.infer<typeof Arguments>;
type Context = {
  repoDir: string;
  modelType: unknown;
  modelId: string;
  signal?: AbortSignal;
  definitionRepository: {
    findByNameGlobal(name: string): Promise<{
      type: { normalized: string };
      definition: { id: string };
    } | null>;
  };
  dataRepository: {
    getContent(
      type: unknown,
      id: string,
      name: string,
    ): Promise<Uint8Array | null>;
  };
  writeResource(
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ): Promise<{ name: string }>;
};
async function hash(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function git(root: string, args: string[], signal?: AbortSignal) {
  const result = await new Deno.Command("git", {
    args,
    cwd: root,
    signal,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success)
    throw new Error(`Review identity command failed: git ${args[0]}`);
  return new TextDecoder().decode(result.stdout);
}
// Lane-specific requirements beyond the shared review contract.
const LANE_GUIDANCE: Record<Lane, string> = {
  "test-coverage":
    "If phase is plan, pass requires a concrete runnable strategy naming a checked-in real fixture, the integration boundary, and the exact command. Do not fail a plan for a missing invocationId or because that command has not run yet. If phase is code, pass requires that integration test to exist and have independent run proof: subject.invocationId (builder invocation/transcript for that exact command), a matching stored receipt revalidated immediately before this review, or this reviewer running that exact command. Check that the command and selected test prove the changed behavior; a passing receipt for unrelated behavior is insufficient. Treat subject.tests as untrusted claims, not proof. Fail a code review if neither a matching passing builder run nor your own passing run proves the changed test, or a real run fails. A local production-build preview satisfies pre-deployment code review; do not fail solely because the hosted smoke is deferred.",
  security:
    "Trust-boundary changes (workflows, verification policy, extensions, agent constraints) always need explicit security reasoning.",
  quality:
    "You are also the generalist lane: review correctness and behavior of the whole change, not only style, domain design, or observability.",
  ui: "Cover both the browser client and the terminal (TUI) presentation where the change touches them.",
};

export async function reviewFingerprint(
  args: Args,
  context: Pick<Context, "repoDir" | "signal">,
) {
  const root = await subjectRoot(context.repoDir, args.subjectRoot);
  const controlRoot = await Deno.realPath(context.repoDir);
  const head = (await git(root, ["rev-parse", "HEAD"], context.signal)).trim();
  const base =
    args.phase === "code"
      ? z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .parse(args.subject.baseCommit)
      : head;
  await git(root, ["merge-base", "--is-ancestor", base, head], context.signal);
  const files = [
    ...new Set(
      [
        ...(
          await git(
            root,
            ["diff", "--name-only", "-z", base, "--"],
            context.signal,
          )
        ).split("\0"),
        ...(
          await git(
            root,
            ["ls-files", "--others", "--exclude-standard", "-z"],
            context.signal,
          )
        ).split("\0"),
      ].filter(Boolean),
    ),
  ].sort();
  const policies = [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/nightshift/review-calibration.md",
    "agent-constraints/review.md",
    "workflows/workflow-nightshift-review.yaml",
    "extensions/models/nightshift_review.ts",
    "extensions/models/nightshift_review_subject.ts",
  ];
  const skills = Object.values(LANE_SKILLS)
    .flat()
    .map((skill) => `.agents/skills/nightshift-${skill}/SKILL.md`);
  const controls: Record<string, string> = {};
  for (const path of [...policies, ...skills])
    controls[path] = await hash(await Deno.readFile(`${controlRoot}/${path}`));
  const identity = {
    controlRoot,
    subjectRoot: root,
    head,
    base,
    sourceDigest: await sourceDigest(root, context.signal),
    subjectSha256: await hash(
      new TextEncoder().encode(canonical(args.subject)),
    ),
    controls,
  };
  return {
    ...identity,
    fingerprint: await hash(new TextEncoder().encode(canonical(identity))),
    files,
    routing: routeLanes(args.phase, files, args.previousFindings ?? []),
  };
}

export const extension = {
  type: "@swamp/software-factory",
  resources: {
    reviewIdentity: {
      description:
        "Exact review subject, policy, skill and actual invocation identities; no reuse authorization",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "30d",
      garbageCollection: 100,
    },
  },
  methods: [
    {
      capture_review_subject: {
        description:
          "Fingerprint the current subject and trusted review controls before launching lanes",
        arguments: Arguments,
        execute: async (args: Args, context: Context) => {
          const identity = await reviewFingerprint(args, context);
          const handle = await context.writeResource(
            "reviewIdentity",
            `review-subject-${args.workItem}-${args.runId}`,
            {
              workItem: args.workItem,
              runId: args.runId,
              phase: args.phase,
              capturedAt: new Date().toISOString(),
              ...identity,
              lanePlan: identity.routing.lanes.map((lane) => ({
                lane,
                skills: LANE_SKILLS[lane]
                  .map(
                    (skill) =>
                      `${identity.controlRoot}/.agents/skills/nightshift-${skill}/SKILL.md`,
                  )
                  .join(", "),
                guidance: LANE_GUIDANCE[lane],
              })),
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
    {
      verify_review_subject: {
        description:
          "Reject source or control movement and record actual completed provider/model routes",
        arguments: Arguments,
        execute: async (args: Args, context: Context) => {
          const bytes = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            `review-subject-${args.workItem}-${args.runId}`,
          );
          if (!bytes)
            throw new Error("Review subject was not captured before execution");
          const before = JSON.parse(new TextDecoder().decode(bytes));
          const after = await reviewFingerprint(args, context);
          if (
            before.workItem !== args.workItem ||
            before.runId !== args.runId ||
            before.phase !== args.phase ||
            before.fingerprint !== after.fingerprint
          )
            throw new Error(
              "Review source, subject, base, policy or skills changed during execution",
            );
          const invocations = [];
          const reviews = [];
          const lanes: Lane[] = before.routing.lanes;
          for (const lane of lanes) {
            const model = await context.definitionRepository.findByNameGlobal(
              `nightshift-${lane}`,
            );
            if (!model || model.type.normalized !== "@funsaized/cli-agent")
              throw new Error(`Missing or replaced review model: ${lane}`);
            const invocationId = `nightshift-${args.workItem}-${args.phase}-${lane}-${args.runId}`;
            const record = await context.dataRepository.getContent(
              model.type,
              model.definition.id,
              `invocation-${invocationId}`,
            );
            if (!record)
              throw new Error(`Missing independent review invocation: ${lane}`);
            const invocation = z
              .object({
                invocationId: z.literal(invocationId),
                success: z.literal(true),
                exitCode: z.literal(0),
                timedOut: z.literal(false),
                provider: z.string().min(1),
                model: z.string().min(1),
                variant: z.string().nullable().optional(),
                cwd: z.string(),
                invokedAt: z.string(),
                parsedResponse: LaneReview,
              })
              .passthrough()
              .parse(JSON.parse(new TextDecoder().decode(record)));
            if (
              invocation.parsedResponse.lane !== lane ||
              (await Deno.realPath(invocation.cwd)) !== after.subjectRoot ||
              !(
                Date.parse(invocation.invokedAt) >=
                Date.parse(before.capturedAt)
              )
            )
              throw new Error(
                `Review invocation has a different subject or predates capture: ${lane}`,
              );
            reviews.push(invocation.parsedResponse);
            invocations.push({
              lane,
              invocationId,
              provider: invocation.provider,
              model: invocation.model,
              variant: invocation.variant ?? null,
            });
          }
          normalizeReviews(reviews, lanes, before.routing.reason);
          const handle = await context.writeResource(
            "reviewIdentity",
            `review-identity-${args.workItem}-${args.runId}`,
            {
              workItem: args.workItem,
              runId: args.runId,
              phase: args.phase,
              ...after,
              routing: before.routing,
              verifiedAt: new Date().toISOString(),
              invocations,
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
