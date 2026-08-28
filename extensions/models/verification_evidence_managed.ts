/** Collects schema-v2 audit data without publishing Git evidence. */
import { dirname } from "jsr:@std/path@1.1.2";
import { z } from "npm:zod@4.4.3";
import { subjectRoot } from "./subject_root.ts";
import {
  artifactFiles,
  base64,
  canonical,
  inside,
  readRegularFile,
  sha256,
  type StoredData,
  tags,
} from "./verification_evidence.ts";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Arguments = z.object({
  commit: Sha,
  baseCommit: Sha,
  subjectRoot: z.string().min(1),
  runId: z.string().uuid(),
  producerKind: z.enum(["local", "github-actions"]).default("local"),
  sourceRepository: z.string().min(1).default("funsaized/herdr-mise"),
  sourceRepositoryId: z.string().default(""),
  baseRepository: z.string().min(1).default("funsaized/herdr-mise"),
  controlRepository: z.string().min(1).default("funsaized/herdr-mise"),
  controlCommit: z.string().default(""),
  producerRepository: z.string().default(""),
  producerWorkflowPath: z.string().default(""),
  producerWorkflowRef: z.string().default(""),
  producerWorkflowId: z.string().default(""),
  producerRunId: z.string().default(""),
  producerRunAttempt: z.string().default(""),
  dispatchActor: z.string().default(""),
});

type Context = {
  repoDir: string;
  globalArgs: {
    managedPolicyPath: string;
    managedOutputPath: string;
  };
  signal?: AbortSignal;
  dataRepository: {
    findAllForModel: (type: string, modelId: string) => Promise<StoredData[]>;
    getContent: (
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};
type PolicyStep = {
  name: string;
  modelName: string;
  modelId: string;
  modelType: string;
  method: string;
  operation?: string;
  projectDir?: string;
  argv?: string[];
  checks?: string[];
  outputs: string[];
};
type Policy = {
  schemaVersion: number;
  workflow: { id: string; name: string; path: string };
  producer: {
    repository: string;
    workflowPath: string;
    workflowRef: string;
    codeOwners: string[];
  };
  configurationFiles: string[];
  artifacts: string[];
  steps: PolicyStep[];
};

async function command(args: string[], cwd: string, signal?: AbortSignal) {
  const result = await new Deno.Command("git", {
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    cwd,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  if (!result.success) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() || "git failed",
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function timing(name: string, value: Record<string, unknown>) {
  const startedAt = String(value.startedAt ?? "");
  const completedAt = String(value.completedAt ?? "");
  const durationMs = value.durationMs;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    completed < started ||
    !Number.isInteger(durationMs) ||
    Number(durationMs) < 0 ||
    Math.abs(completed - started - Number(durationMs)) > 1000
  ) {
    throw new Error(`${name}: invalid step timing`);
  }
  return { startedAt, completedAt, durationMs };
}

async function assertStep(
  step: PolicyStep,
  records: Array<{ specName: string; bytes: Uint8Array }>,
  commit: string,
  baseCommit: string,
  root: string,
) {
  const resultSpec = step.modelType.includes("npm")
    ? "invocation"
    : step.modelType === "@swamp/git"
      ? "subjectResult"
      : "result";
  const result = records.find((record) => record.specName === resultSpec);
  if (!result) throw new Error(`${step.name}: structured result is missing`);
  const value = JSON.parse(new TextDecoder().decode(result.bytes));
  if (resultSpec === "subjectResult") {
    if (
      value.commit !== commit ||
      value.baseCommit !== baseCommit ||
      value.clean !== true ||
      !/^[0-9a-f]{40}$/.test(value.tree)
    )
      throw new Error(`${step.name}: source preflight does not match`);
  } else if (resultSpec === "invocation") {
    if (
      value.operation !== step.operation ||
      value.projectDir !== step.projectDir ||
      JSON.stringify(value.argv) !== JSON.stringify(step.argv) ||
      value.executionStatus !== "succeeded" ||
      value.exitCode !== 0 ||
      value.expectedGitHead !== commit ||
      value.gitHeadBefore !== commit ||
      value.gitHeadAfter !== commit ||
      value.cleanWorktreeBefore !== true ||
      value.cleanWorktreeAfter !== true ||
      value.packageJsonSha256Before !== value.packageJsonSha256After ||
      value.lockfileSha256Before !== value.lockfileSha256After ||
      value.lockfilePath !== "package-lock.json"
    )
      throw new Error(`${step.name}: npm invocation does not match policy`);
    const projectDir = step.projectDir ?? ".";
    if (
      value.packageJsonSha256Before !==
        (await sha256(
          await readRegularFile(root, `${projectDir}/package.json`),
        )) ||
      value.lockfileSha256Before !==
        (await sha256(
          await readRegularFile(root, `${projectDir}/package-lock.json`),
        ))
    )
      throw new Error(`${step.name}: npm metadata does not match subject`);
  } else {
    if (
      value.status !== "passed" ||
      value.gitHead !== commit ||
      !Array.isArray(value.checks) ||
      value.checks.some(
        (check: { status: string }) => check.status !== "passed",
      ) ||
      JSON.stringify(
        value.checks.map((check: { name: string }) => check.name),
      ) !== JSON.stringify(step.checks) ||
      value.cargoLockSha256 !==
        (await sha256(await readRegularFile(root, "Cargo.lock")))
    )
      throw new Error(`${step.name}: Rust verification does not match policy`);
  }
  return { ...timing(step.name, value), value };
}

async function collectManaged(
  args: z.infer<typeof Arguments>,
  context: Context,
) {
  const policyBytes = await readRegularFile(
    context.repoDir,
    context.globalArgs.managedPolicyPath,
  );
  const policy = JSON.parse(new TextDecoder().decode(policyBytes)) as Policy;
  if (policy.schemaVersion !== 2) throw new Error("unsupported managed policy");
  const root = await subjectRoot(context.repoDir, args.subjectRoot);
  const control = await Deno.realPath(context.repoDir);
  const controlCommit = await command(
    ["rev-parse", "HEAD"],
    control,
    context.signal,
  );
  const expectedControl = args.controlCommit || controlCommit;
  if (controlCommit !== expectedControl)
    throw new Error("control commit does not match");
  if (args.producerKind === "github-actions") {
    if (root === control)
      throw new Error("managed subject must be separate from control");
    for (const [name, value] of Object.entries({
      sourceRepositoryId: args.sourceRepositoryId,
      controlCommit: args.controlCommit,
      producerRepository: args.producerRepository,
      producerWorkflowPath: args.producerWorkflowPath,
      producerWorkflowRef: args.producerWorkflowRef,
      producerWorkflowId: args.producerWorkflowId,
      producerRunId: args.producerRunId,
      producerRunAttempt: args.producerRunAttempt,
      dispatchActor: args.dispatchActor,
    }))
      if (!value) throw new Error(`managed producer field is missing: ${name}`);
  }
  const sourceCommit = await command(
    ["rev-parse", "HEAD"],
    root,
    context.signal,
  );
  if (sourceCommit !== args.commit)
    throw new Error("subject HEAD does not match");
  if (await command(["status", "--porcelain"], root, context.signal)) {
    throw new Error("subject worktree is not clean");
  }
  const tree = await command(
    ["rev-parse", "HEAD^{tree}"],
    root,
    context.signal,
  );

  const configuration: Record<string, string> = {};
  for (const path of [...policy.configurationFiles].sort()) {
    configuration[path] = await sha256(await readRegularFile(control, path));
  }
  let recordCount = 0;
  const steps = [];
  for (const step of policy.steps) {
    const all = await context.dataRepository.findAllForModel(
      step.modelType,
      step.modelId,
    );
    const matching = all.filter((data) => {
      const dataTags = tags(data);
      return (
        (data.workflowRunId ?? dataTags.workflowRunId) === args.runId &&
        (data.stepName ?? dataTags.step) === step.name
      );
    });
    const actualSpecs = matching
      .map((data) => tags(data).specName ?? data.specName)
      .sort();
    if (
      JSON.stringify(actualSpecs) !== JSON.stringify([...step.outputs].sort())
    ) {
      throw new Error(`${step.name}: output set does not match policy`);
    }
    const rawRecords = [];
    const records = [];
    for (const data of matching.sort((a, b) => a.name.localeCompare(b.name))) {
      const bytes = await context.dataRepository.getContent(
        step.modelType,
        step.modelId,
        data.name,
        data.version,
      );
      if (!bytes) throw new Error(`${step.name}: cannot read ${data.name}`);
      const specName = tags(data).specName ?? data.specName ?? "";
      rawRecords.push({ specName, bytes });
      records.push({
        id: data.dataId ?? data.id ?? "",
        name: data.name,
        version: data.version,
        specName,
        contentType:
          data.metadata?.contentType ??
          data.contentType ??
          "application/octet-stream",
        size: bytes.length,
        sha256: await sha256(bytes),
        contentBase64: base64(bytes),
      });
      recordCount += 1;
    }
    const stepTiming = await assertStep(
      step,
      rawRecords,
      args.commit,
      args.baseCommit,
      root,
    );
    steps.push({
      name: step.name,
      modelName: step.modelName,
      modelType: step.modelType,
      method: step.method,
      status: "succeeded",
      startedAt: stepTiming.startedAt,
      completedAt: stepTiming.completedAt,
      durationMs: stepTiming.durationMs,
      records,
    });
  }
  const artifacts = [];
  for (const path of policy.artifacts)
    artifacts.push(await artifactFiles(root, path));
  const workflowBytes = await readRegularFile(
    context.repoDir,
    policy.workflow.path,
  );
  const swampVersion = await new Deno.Command("swamp", {
    args: ["--version"],
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
    signal: context.signal,
  }).output();
  if (!swampVersion.success) throw new Error("cannot determine Swamp version");
  const unsigned = {
    schemaVersion: 2,
    source: {
      repository: args.sourceRepository,
      ...(args.sourceRepositoryId
        ? { repositoryId: args.sourceRepositoryId }
        : {}),
      commit: args.commit,
      tree,
    },
    base: {
      repository: args.baseRepository,
      branch: "main",
      commit: args.baseCommit,
    },
    control: {
      repository: args.controlRepository,
      commit: expectedControl,
      policySha256: await sha256(policyBytes),
      workflowSha256: await sha256(workflowBytes),
      swampVersion: new TextDecoder()
        .decode(swampVersion.stdout)
        .trim()
        .replace(/^swamp\s+/, ""),
    },
    producer:
      args.producerKind === "local"
        ? { kind: "local" }
        : {
            kind: "github-actions",
            githubRepository: args.producerRepository,
            workflowPath: args.producerWorkflowPath,
            workflowRef: args.producerWorkflowRef,
            workflowId: args.producerWorkflowId,
            runId: args.producerRunId,
            runAttempt: args.producerRunAttempt,
            dispatchActor: args.dispatchActor,
          },
    workflow: {
      id: policy.workflow.id,
      name: policy.workflow.name,
      runId: args.runId,
    },
    configuration: { algorithm: "sha256", files: configuration },
    steps,
    artifacts,
    verdict: "pass",
    createdAt: new Date().toISOString(),
  };
  const evidenceRootSha256 = await sha256(canonical(unsigned));
  const manifest = { ...unsigned, evidenceRootSha256 };
  const destination = inside(
    context.repoDir,
    context.globalArgs.managedOutputPath,
  );
  await Deno.mkdir(dirname(destination), { recursive: true });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) {
    throw new Error("managed manifest exceeds 2 MiB");
  }
  const temporary = `${destination}.tmp`;
  await Deno.writeTextFile(temporary, text);
  await Deno.rename(temporary, destination);
  const handle = await context.writeResource(
    "evidence",
    `managed-${args.runId}`,
    {
      commit: args.commit,
      runId: args.runId,
      evidenceRootSha256,
      relativePath: context.globalArgs.managedOutputPath,
      steps: steps.length,
      records: recordCount,
      artifacts: artifacts.reduce(
        (count, artifact) => count + artifact.files.length,
        0,
      ),
    },
  );
  return { dataHandles: [handle] };
}

export const extension = {
  type: "@funsaized/verification-evidence",
  methods: [
    {
      collectManaged: {
        description: "Collect one schema-v2 managed verification audit record",
        arguments: Arguments,
        execute: collectManaged,
      },
    },
  ],
};
