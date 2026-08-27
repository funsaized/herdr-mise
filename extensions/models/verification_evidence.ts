/** Collects one completed verification run into durable Git evidence. */
import { z } from "npm:zod@4.4.3";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "jsr:@std/path@1.1.2";

const maxManifestBytes = 2 * 1024 * 1024;

const GlobalArguments = z.object({
  evidenceRepoPath: z.string().default(".swamp/ops-evidence"),
  policyPath: z.string().default("verification/policy.json"),
});

const CollectArguments = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  runId: z.string().uuid(),
});

const Summary = z.object({
  commit: z.string(),
  runId: z.string(),
  evidenceRootSha256: z.string(),
  relativePath: z.string(),
  steps: z.number().int().positive(),
  records: z.number().int().positive(),
  artifacts: z.number().int().positive(),
});

type StoredData = {
  id?: string;
  dataId?: string;
  name: string;
  version: number;
  size?: number;
  contentType?: string;
  specName?: string;
  workflowRunId?: string;
  stepName?: string;
  tags?: Record<string, string>;
  metadata?: {
    contentType?: string;
    tags?: Record<string, string>;
  };
};

type Context = {
  repoDir: string;
  globalArgs: z.infer<typeof GlobalArguments>;
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
  projectDir?: string;
  argv?: string[];
  checks?: string[];
  outputs: string[];
};

type Policy = {
  schemaVersion: number;
  workflow: { id: string; name: string };
  evidenceBranch: string;
  configurationFiles: string[];
  artifacts: string[];
  steps: PolicyStep[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const content =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", content as BufferSource),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function command(
  executable: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const output = await new Deno.Command(executable, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  if (!output.success) {
    throw new Error(
      new TextDecoder().decode(output.stderr).trim() || `${executable} failed`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const child = relative(root, absolute);
  if (
    isAbsolute(child) ||
    child === ".." ||
    child.startsWith("../") ||
    child.startsWith("..\\")
  ) {
    throw new Error(`path escapes repository: ${path}`);
  }
  return absolute;
}

async function readRegularFile(
  root: string,
  path: string,
): Promise<Uint8Array> {
  const absolute = inside(root, path);
  const info = await Deno.lstat(absolute);
  if (!info.isFile || info.isSymlink)
    throw new Error(`${path} is not a regular file`);
  const realRoot = await Deno.realPath(root);
  const realPath = await Deno.realPath(absolute);
  inside(realRoot, realPath);
  return await Deno.readFile(realPath);
}

async function artifactFiles(root: string, path: string) {
  const absolute = inside(root, path);
  const stat = await Deno.lstat(absolute);
  const paths: string[] = [];
  if (stat.isFile) paths.push(absolute);
  else if (stat.isDirectory) {
    for await (const entry of Deno.readDir(absolute)) {
      const pending = [join(absolute, entry.name)];
      while (pending.length) {
        const current = pending.pop()!;
        const currentStat = await Deno.lstat(current);
        if (currentStat.isSymlink)
          throw new Error(`artifact symlink is forbidden: ${current}`);
        if (currentStat.isFile) paths.push(current);
        else if (currentStat.isDirectory) {
          for await (const child of Deno.readDir(current))
            pending.push(join(current, child.name));
        }
      }
    }
  } else
    throw new Error(`artifact is not a regular file or directory: ${path}`);

  const files = [];
  for (const file of paths.sort()) {
    const content = await Deno.readFile(file);
    const fileStat = await Deno.stat(file);
    files.push({
      path: relative(root, file),
      size: content.length,
      executable: (fileStat.mode ?? 0) & 0o111 ? true : false,
      sha256: await sha256(content),
    });
  }
  if (!files.length) throw new Error(`artifact has no files: ${path}`);
  return { path, files };
}

function tags(data: StoredData): Record<string, string> {
  return data.metadata?.tags ?? data.tags ?? {};
}

async function assertResult(
  step: PolicyStep,
  records: Array<{ specName: string; bytes: Uint8Array }>,
  commit: string,
  root: string,
): Promise<void> {
  const result = records.find(
    (record) =>
      record.specName ===
      (step.modelType.includes("npm") ? "invocation" : "result"),
  );
  if (!result) throw new Error(`${step.name}: structured result is missing`);
  const value = JSON.parse(new TextDecoder().decode(result.bytes));
  if (step.modelType.includes("npm")) {
    if (
      value.operation !== step.method ||
      value.projectDir !== step.projectDir ||
      JSON.stringify(value.argv) !== JSON.stringify(step.argv)
    ) {
      throw new Error(`${step.name}: npm command does not match policy`);
    }
    if (value.executionStatus !== "succeeded" || value.exitCode !== 0) {
      throw new Error(`${step.name}: npm invocation did not succeed`);
    }
    if (
      value.expectedGitHead !== commit ||
      value.gitHeadBefore !== commit ||
      value.gitHeadAfter !== commit
    ) {
      throw new Error(`${step.name}: invocation is not bound to ${commit}`);
    }
    if (
      value.cleanWorktreeBefore !== true ||
      value.cleanWorktreeAfter !== true
    ) {
      throw new Error(`${step.name}: invocation used a dirty worktree`);
    }
    if (
      value.packageJsonSha256Before !== value.packageJsonSha256After ||
      value.lockfileSha256Before !== value.lockfileSha256After
    ) {
      throw new Error(
        `${step.name}: package metadata changed during execution`,
      );
    }
    if (value.lockfilePath !== "package-lock.json") {
      throw new Error(`${step.name}: unexpected npm lockfile path`);
    }
    const projectDir = step.projectDir ?? ".";
    if (
      value.packageJsonSha256Before !==
        (await sha256(
          await readRegularFile(root, join(projectDir, "package.json")),
        )) ||
      value.lockfileSha256Before !==
        (await sha256(
          await readRegularFile(root, join(projectDir, value.lockfilePath)),
        ))
    ) {
      throw new Error(
        `${step.name}: package metadata does not match the source commit`,
      );
    }
  } else {
    const checkNames = Array.isArray(value.checks)
      ? value.checks.map((check: { name: string }) => check.name)
      : [];
    if (
      value.status !== "passed" ||
      value.gitHead !== commit ||
      !Array.isArray(value.checks) ||
      !value.checks.length ||
      value.checks.some(
        (check: { status: string }) => check.status !== "passed",
      ) ||
      JSON.stringify(checkNames) !== JSON.stringify(step.checks) ||
      value.cargoLockSha256 !==
        (await sha256(await readRegularFile(root, "Cargo.lock")))
    ) {
      throw new Error(`${step.name}: Rust verification did not pass`);
    }
  }
}

async function collect(
  args: z.infer<typeof CollectArguments>,
  context: Context,
) {
  const policyPath = inside(context.repoDir, context.globalArgs.policyPath);
  const policy = JSON.parse(await Deno.readTextFile(policyPath)) as Policy;
  if (policy.schemaVersion !== 1)
    throw new Error("unsupported verification policy");

  const head = await command(
    "git",
    ["rev-parse", "HEAD"],
    context.repoDir,
    context.signal,
  );
  if (head !== args.commit)
    throw new Error(`expected HEAD ${args.commit}, found ${head}`);
  if (
    await command(
      "git",
      ["status", "--porcelain"],
      context.repoDir,
      context.signal,
    )
  ) {
    throw new Error("verification evidence requires a clean worktree");
  }
  const tree = await command(
    "git",
    ["rev-parse", "HEAD^{tree}"],
    context.repoDir,
    context.signal,
  );
  const evidenceRepo = inside(
    context.repoDir,
    context.globalArgs.evidenceRepoPath,
  );
  const evidenceBranch = await command(
    "git",
    ["branch", "--show-current"],
    evidenceRepo,
    context.signal,
  );
  if (evidenceBranch !== policy.evidenceBranch) {
    throw new Error(
      `evidence repository is on ${evidenceBranch || "detached HEAD"}, expected ${policy.evidenceBranch}`,
    );
  }
  if (
    await command(
      "git",
      ["status", "--porcelain"],
      evidenceRepo,
      context.signal,
    )
  ) {
    throw new Error("evidence repository has uncommitted changes");
  }

  const configuration: Record<string, string> = {};
  for (const path of policy.configurationFiles) {
    configuration[path] = await sha256(
      await readRegularFile(context.repoDir, path),
    );
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
      throw new Error(
        `${step.name}: expected ${step.outputs.join(", ")}, found ${actualSpecs.join(", ")}`,
      );
    }

    const rawRecords = [];
    const records = [];
    for (const data of matching.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const bytes = await context.dataRepository.getContent(
        step.modelType,
        step.modelId,
        data.name,
        data.version,
      );
      if (!bytes)
        throw new Error(
          `${step.name}: cannot read ${data.name}@${data.version}`,
        );
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
    await assertResult(step, rawRecords, args.commit, context.repoDir);
    steps.push({
      name: step.name,
      modelName: step.modelName,
      modelType: step.modelType,
      method: step.method,
      status: "succeeded",
      records,
    });
  }

  const artifacts = [];
  for (const path of policy.artifacts)
    artifacts.push(await artifactFiles(context.repoDir, path));

  const unsigned = {
    schemaVersion: 1,
    source: { commit: args.commit, tree },
    workflow: { ...policy.workflow, runId: args.runId },
    configuration: { algorithm: "sha256", files: configuration },
    steps,
    artifacts,
    verdict: "pass",
    createdAt: new Date().toISOString(),
  };
  const evidenceRootSha256 = await sha256(canonical(unsigned));
  const manifest = { ...unsigned, evidenceRootSha256 };
  const relativePath = `evidence/v1/${args.commit}/${args.runId}/manifest.json`;
  const destination = inside(evidenceRepo, relativePath);
  try {
    await Deno.lstat(destination);
    throw new Error(`evidence already exists: ${relativePath}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (new TextEncoder().encode(manifestText).length > maxManifestBytes) {
    throw new Error(`evidence manifest exceeds ${maxManifestBytes} bytes`);
  }
  await Deno.writeTextFile(temporary, manifestText);
  await Deno.rename(temporary, destination);

  const handle = await context.writeResource(
    "evidence",
    `evidence-${args.runId}`,
    {
      commit: args.commit,
      runId: args.runId,
      evidenceRootSha256,
      relativePath,
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

export const model = {
  type: "@funsaized/verification-evidence",
  version: "2026.08.27.1",
  globalArguments: GlobalArguments,
  resources: {
    evidence: {
      description: "Published verification evidence summary",
      schema: Summary,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    collect: {
      description:
        "Collect and hash exact outputs for one verification workflow run",
      arguments: CollectArguments,
      execute: collect,
    },
  },
};
