/** Adds path-bounded subject execution to @funsaized/npm/project. */
import { isAbsolute, join, relative, resolve } from "jsr:@std/path@1.1.2";
import { z } from "npm:zod@4.4.3";
import { subjectRoot } from "./subject_root.ts";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const CommonArguments = z.object({
  subjectRoot: z.string().min(1),
  expectedGitHead: Sha,
});
const RunArguments = CommonArguments.extend({
  script: z.string().min(1),
  args: z.array(z.string()).default([]),
});

type GlobalArguments = {
  projectDir: string;
  lifecycleScripts: "allow" | "deny";
  allowedScripts: string[];
  environment: Record<string, string>;
  defaultTimeoutMs: number;
  requireCleanGit: boolean;
};
type Handle = { name: string };
type FileWriter = {
  writeLine(line: string): Promise<void>;
  finalize(): Promise<Handle>;
};
type Context = {
  repoDir: string;
  globalArgs: GlobalArguments;
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Handle>;
  createFileWriter: (
    specName: string,
    name: string,
    options: { streaming: boolean },
  ) => FileWriter;
};

async function sha256File(path: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      (await Deno.readFile(path)) as BufferSource,
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function projectRoot(root: string, projectDir: string): Promise<string> {
  const candidate = resolve(root, projectDir);
  const child = relative(root, candidate);
  if (isAbsolute(child) || child === ".." || child.startsWith("../")) {
    throw new Error(`projectDir escapes subjectRoot: ${projectDir}`);
  }
  const info = await Deno.lstat(candidate);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`projectDir is not a regular directory: ${projectDir}`);
  }
  const real = await Deno.realPath(candidate);
  const realChild = relative(root, real);
  if (
    isAbsolute(realChild) ||
    realChild === ".." ||
    realChild.startsWith("../")
  ) {
    throw new Error(`projectDir resolves outside subjectRoot: ${projectDir}`);
  }
  return real;
}

async function capture(
  executable: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const output = await new Deno.Command(executable, {
    args,
    cwd,
    env,
    clearEnv: true,
    signal,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      new TextDecoder().decode(output.stderr).trim() || `${executable} failed`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

async function runLogged(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  log: FileWriter,
  signal?: AbortSignal,
): Promise<number> {
  await log.writeLine(`[command] npm ${args.join(" ")}`);
  const timeout = AbortSignal.timeout(timeoutMs);
  const cancellation = new AbortController();
  const child = new Deno.Command("npm", {
    args,
    cwd,
    env,
    clearEnv: true,
    signal: AbortSignal.any([
      cancellation.signal,
      timeout,
      ...(signal ? [signal] : []),
    ]),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let written = 0;
  let truncated = false;
  let queue = Promise.resolve();
  let failure: unknown;
  const write = async (line: string) => {
    queue = queue
      .then(() => log.writeLine(line))
      .catch((error) => {
        failure ??= error;
        cancellation.abort();
      });
    await queue;
    if (failure) throw failure;
  };
  const pump = async (name: string, stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (written >= 8 * 1024 * 1024) {
          truncated = true;
          continue;
        }
        written += value.length;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          await write(`[${name}] ${line}`);
        }
      }
      pending += decoder.decode();
      if (pending) await write(`[${name}] ${pending}`);
    } catch (error) {
      failure ??= error;
      cancellation.abort();
      throw error;
    } finally {
      reader.releaseLock();
    }
  };
  const results = await Promise.allSettled([
    pump("stdout", child.stdout),
    pump("stderr", child.stderr),
    child.status,
  ]);
  await queue;
  if (failure) throw failure;
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  if (truncated) await log.writeLine("[error] output exceeded 8 MiB");
  const status = results[2];
  if (status.status !== "fulfilled") throw status.reason;
  return status.value.code;
}

export function subjectEnvironment(
  temp: string,
  inherited: Record<string, string>,
  configured: Record<string, string>,
): Record<string, string> {
  // Resolve the same default as test-extensions before HOME is isolated.
  const deno =
    inherited.DENO_EXEC_PATH ||
    (inherited.HOME
      ? join(inherited.HOME, ".swamp", "deno", "deno")
      : undefined);
  return {
    PATH: inherited.PATH ?? "",
    ...(deno ? { DENO_EXEC_PATH: deno } : {}),
    ...(inherited.DENO_TLS_CA_STORE
      ? { DENO_TLS_CA_STORE: inherited.DENO_TLS_CA_STORE }
      : {}),
    ...(inherited.NPM_CONFIG_CACHE
      ? { NPM_CONFIG_CACHE: inherited.NPM_CONFIG_CACHE }
      : {}),
    ...configured,
    HOME: temp,
    CARGO_HOME: inherited.CARGO_HOME ?? `${inherited.HOME}/.cargo`,
    RUSTUP_HOME: inherited.RUSTUP_HOME ?? `${inherited.HOME}/.rustup`,
    PLAYWRIGHT_BROWSERS_PATH: "0",
    NPM_CONFIG_USERCONFIG: `${temp}/npmrc`,
    NPM_CONFIG_GLOBALCONFIG: `${temp}/global-npmrc`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function execute(
  operation: "ci" | "run",
  args: z.infer<typeof CommonArguments> & { script?: string; args?: string[] },
  context: Context,
) {
  const started = Date.now();
  const suffix = `${started}-${crypto.randomUUID().slice(0, 8)}`;
  const commandArgs =
    operation === "ci"
      ? [
          "ci",
          "--no-audit",
          "--no-fund",
          ...(context.globalArgs.lifecycleScripts === "deny"
            ? ["--ignore-scripts"]
            : []),
        ]
      : [
          "run",
          args.script!,
          ...(args.args?.length ? ["--", ...args.args] : []),
        ];
  const argv = ["npm", ...commandArgs];
  const evidence: Record<string, unknown> = {
    operation,
    argv,
    projectDir: context.globalArgs.projectDir,
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(started).toISOString(),
    durationMs: 0,
    exitCode: null,
    executionStatus: "failed",
    error: null,
    npmVersion: null,
    nodeVersion: null,
    platform: `${Deno.build.os}-${Deno.build.arch}`,
    workspaces: [],
    lifecyclePolicy: context.globalArgs.lifecycleScripts,
    environmentKeys: Object.keys(context.globalArgs.environment).sort(),
    expectedGitHead: args.expectedGitHead,
    packageJsonSha256Before: null,
    packageJsonSha256After: null,
    lockfilePath: "package-lock.json",
    lockfileSha256Before: null,
    lockfileSha256After: null,
    npmrcSha256: null,
    gitHeadBefore: null,
    gitHeadAfter: null,
    cleanWorktreeBefore: null,
    cleanWorktreeAfter: null,
  };
  let temp: string | undefined;
  let log: FileWriter | undefined;
  let failure: unknown;
  const errors: string[] = [];
  const remember = (error: unknown) => {
    failure ??= error;
    errors.push(error instanceof Error ? error.message : String(error));
  };
  try {
    log = context.createFileWriter("log", `log-${operation}-${suffix}`, {
      streaming: true,
    });
    const root = await subjectRoot(context.repoDir, args.subjectRoot);
    const project = await projectRoot(root, context.globalArgs.projectDir);
    const packagePath = `${project}/package.json`;
    const lockPath = `${project}/package-lock.json`;
    const packageJson = JSON.parse(await Deno.readTextFile(packagePath));
    if (operation === "run") {
      if (!context.globalArgs.allowedScripts.includes(args.script ?? "")) {
        throw new Error(`npm script is not allowlisted: ${args.script}`);
      }
      if (typeof packageJson.scripts?.[args.script ?? ""] !== "string") {
        throw new Error(`npm script does not exist: ${args.script}`);
      }
    }
    if ((await sha256File(lockPath)) === null) {
      throw new Error(
        `package-lock.json not found in ${context.globalArgs.projectDir}`,
      );
    }
    temp = await Deno.makeTempDir({ prefix: "swamp-npm-subject-" });
    await Deno.writeTextFile(`${temp}/npmrc`, "");
    await Deno.writeTextFile(`${temp}/global-npmrc`, "");
    const env = subjectEnvironment(
      temp,
      Deno.env.toObject(),
      context.globalArgs.environment,
    );
    const before = {
      packageJson: await sha256File(packagePath),
      lockfile: await sha256File(lockPath),
      npmrc: await sha256File(`${project}/.npmrc`),
      head: await capture(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "rev-parse",
          "HEAD",
        ],
        root,
        env,
        context.signal,
      ),
      clean: !(await capture(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain",
        ],
        root,
        env,
        context.signal,
      )),
    };
    Object.assign(evidence, {
      packageJsonSha256Before: before.packageJson,
      lockfileSha256Before: before.lockfile,
      npmrcSha256: before.npmrc,
      gitHeadBefore: before.head,
      cleanWorktreeBefore: before.clean,
    });
    if (before.head !== args.expectedGitHead) {
      throw new Error(
        `expected HEAD ${args.expectedGitHead}, found ${before.head}`,
      );
    }
    if (context.globalArgs.requireCleanGit && !before.clean) {
      throw new Error("npm subject execution requires a clean worktree");
    }
    Object.assign(evidence, {
      npmVersion: await capture(
        "npm",
        ["--version"],
        project,
        env,
        context.signal,
      ),
      nodeVersion: await capture(
        "node",
        ["--version"],
        project,
        env,
        context.signal,
      ),
    });
    const exitCode = await runLogged(
      commandArgs,
      project,
      env,
      context.globalArgs.defaultTimeoutMs,
      log,
      context.signal,
    );
    const after = {
      packageJson: await sha256File(packagePath),
      lockfile: await sha256File(lockPath),
      head: await capture(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "rev-parse",
          "HEAD",
        ],
        root,
        env,
        context.signal,
      ),
      clean: !(await capture(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain",
        ],
        root,
        env,
        context.signal,
      )),
    };
    Object.assign(evidence, {
      exitCode,
      packageJsonSha256After: after.packageJson,
      lockfileSha256After: after.lockfile,
      gitHeadAfter: after.head,
      cleanWorktreeAfter: after.clean,
    });
    if (exitCode !== 0) throw new Error(`npm ${operation} exited ${exitCode}`);
    if (
      before.packageJson !== after.packageJson ||
      before.lockfile !== after.lockfile ||
      before.head !== after.head ||
      (context.globalArgs.requireCleanGit && !after.clean)
    ) {
      throw new Error("npm subject execution changed source state");
    }
  } catch (error) {
    remember(error);
  } finally {
    if (temp) {
      try {
        await Deno.remove(temp, { recursive: true });
      } catch (error) {
        remember(error);
      }
    }
  }
  if (errors.length && log) {
    try {
      await log.writeLine(`[error] ${errors.join("; ")}`);
    } catch (error) {
      remember(error);
    }
  }
  let logHandle: Handle | undefined;
  if (log) {
    try {
      logHandle = await log.finalize();
    } catch (error) {
      remember(error);
    }
  }
  evidence.executionStatus = errors.length ? "failed" : "succeeded";
  evidence.error = errors.length ? errors.join("; ") : null;
  evidence.completedAt = new Date().toISOString();
  evidence.durationMs = Date.now() - started;
  let invocation: Handle | undefined;
  try {
    invocation = await context.writeResource(
      "invocation",
      `invocation-${operation}-${suffix}`,
      evidence,
    );
  } catch (error) {
    remember(error);
  }
  if (errors.length) throw failure;
  return { dataHandles: [invocation!, logHandle!] };
}

export const extension = {
  type: "@funsaized/npm/project",
  methods: [
    {
      ci_subject: {
        description: "Run npm ci in a bounded verification subject",
        arguments: CommonArguments,
        execute: async (
          args: z.infer<typeof CommonArguments>,
          context: Context,
        ) => await execute("ci", args, context),
      },
    },
    {
      run_subject: {
        description:
          "Run an allowlisted npm script in a bounded verification subject",
        arguments: RunArguments,
        execute: async (args: z.infer<typeof RunArguments>, context: Context) =>
          await execute("run", args, context),
      },
    },
  ],
};
