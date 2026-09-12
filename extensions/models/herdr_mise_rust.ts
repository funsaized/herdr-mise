/** Runs the repository's deterministic Rust verification controls. */
import { z } from "npm:zod@4.4.3";
import { subjectPath, subjectRoot } from "./subject_root.ts";

const GlobalArguments = z.object({});
const VerifyArguments = z.object({
  expectedGitHead: z.string().regex(/^[0-9a-f]{40}$/),
  subjectRoot: z.string().min(1).default("."),
});
const PreviewArguments = z.object({
  sourceRoot: z.string().min(1),
  expectedCommit: z.string().regex(/^[0-9a-f]{40}$/),
  expectedTag: z.string().regex(/^preview-\d{4}-\d{2}-\d{2}-[0-9a-f]{12}$/),
});

type Context = {
  globalArgs: z.infer<typeof GlobalArguments>;
  repoDir: string;
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

function environment() {
  const inherited = Deno.env.toObject();
  return {
    ...Object.fromEntries(
      [
        "PATH",
        "HOME",
        "USERPROFILE",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "WINDIR",
      ]
        .filter((key) => inherited[key] !== undefined)
        .map((key) => [key, inherited[key]]),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

const Check = z.object({
  name: z.string(),
  status: z.enum(["passed", "failed"]),
  durationMs: z.number().int().nonnegative(),
});

const Result = z.object({
  status: z.enum(["passed", "failed"]),
  checks: z.array(Check),
  error: z.string().optional(),
  gitHead: z.string(),
  cargoLockSha256: z.string(),
  cargoVersion: z.string(),
  rustcVersion: z.string(),
  platform: z.string(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
});

const CanaryVerdict = z.enum(["passed", "failed", "unavailable"]);
const PreviewCanaryResult = z.object({
  status: z.enum(["passed", "failed"]),
  repository: z.literal("https://github.com/herdrdev/herdr.git"),
  tag: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  tree: z.string().regex(/^[0-9a-f]{40}$/),
  cargoLockSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceClean: z.boolean(),
  build: CanaryVerdict,
  sandbox: z.object({
    bwrap: z.boolean(),
    noEgress: z.boolean(),
    credentialsHidden: z.boolean(),
    filesystemSentinelHidden: z.boolean(),
  }),
  transcript: z.array(z.string()).max(80),
  cleanupCompleted: z.boolean(),
  error: z.string().optional(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
});

async function output(
  command: string,
  args: string[],
  cwd: string,
  context: Context,
) {
  const result = await new Deno.Command(command, {
    args:
      command === "git"
        ? [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            ...args,
          ]
        : args,
    cwd,
    env: environment(),
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
    signal: context.signal,
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function sha256(path: string) {
  const content = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", content as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function command(
  executable: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(45 * 60 * 1000);
  return await new Deno.Command(executable, {
    args,
    cwd,
    env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).output();
}

export function previewSandboxArgs(
  source: string,
  cargoHome: string,
  rustSysroot: string,
  scratch: string,
) {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--cap-drop",
    "ALL",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--ro-bind",
    source,
    "/src",
    "--dir",
    "/cargo",
    "--ro-bind",
    rustSysroot,
    "/rust",
    "--bind",
    scratch,
    "/work",
  ];
  for (const name of ["registry", "git"]) {
    const path = `${cargoHome}/${name}`;
    try {
      Deno.statSync(path);
      args.push("--ro-bind", path, `/cargo/${name}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  for (const path of ["/usr", "/bin", "/lib", "/lib64"]) {
    try {
      Deno.statSync(path);
      args.push("--ro-bind", path, path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return args;
}

const probeScript = String.raw`
set -eu
command -v getent >/dev/null
command -v python3 >/dev/null
test -e /src/Cargo.toml
test ! -e "$CREDENTIAL_SENTINEL" && touch /work/credentials-hidden
test ! -e "$FILESYSTEM_SENTINEL" && touch /work/filesystem-sentinel-hidden
! getent hosts github.com >/dev/null 2>&1 && touch /work/dns-denied
! python3 -c 'import socket; socket.create_connection(("1.1.1.1",443),1)' >/dev/null 2>&1 && touch /work/https-denied
! python3 -c 'import socket; socket.create_connection(("10.0.0.1",443),1)' >/dev/null 2>&1 && touch /work/private-network-denied
! python3 -c 'import socket; socket.create_connection(("169.254.169.254",80),1)' >/dev/null 2>&1 && touch /work/metadata-denied
`;

async function previewCanary(
  args: z.infer<typeof PreviewArguments>,
  context: Context,
) {
  const started = Date.now();
  const root = await subjectRoot(context.repoDir, args.sourceRoot);
  const runGit = (gitArgs: string[]) => output("git", gitArgs, root, context);
  const repository = await runGit(["remote", "get-url", "origin"]);
  if (repository !== "https://github.com/herdrdev/herdr.git")
    throw new Error(`unexpected preview remote: ${repository}`);
  const commit = await runGit(["rev-parse", "HEAD"]);
  const tagCommit = await runGit([
    "rev-parse",
    `refs/tags/${args.expectedTag}^{commit}`,
  ]);
  if (commit !== args.expectedCommit || tagCommit !== args.expectedCommit)
    throw new Error("preview tag and HEAD do not match the discovered commit");
  const tree = await runGit(["rev-parse", "HEAD^{tree}"]);
  if (await runGit(["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("preview checkout is not clean");
  const lock = await sha256(`${root}/Cargo.lock`);
  const scratch = await Deno.makeTempDir({ prefix: "herdr-preview-canary-" });
  let status: "passed" | "failed" = "failed";
  let build: "passed" | "failed" | "unavailable" = "unavailable";
  let stage = "dependency acquisition";
  let errorMessage: string | undefined;
  let cleanupCompleted = false;
  const transcript = ["source identity verified"];
  const sandboxEvidence = {
    bwrap: false,
    noEgress: false,
    credentialsHidden: false,
    filesystemSentinelHidden: false,
  };
  try {
    const cargoHome = `${scratch}/cargo-home`;
    const empty = `${scratch}/empty`;
    const work = `${scratch}/work`;
    await Promise.all([cargoHome, empty, work].map((path) => Deno.mkdir(path)));
    const trustedEnv = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: `${scratch}/fetch-home`,
      CARGO_HOME: cargoHome,
      RUSTUP_HOME:
        Deno.env.get("RUSTUP_HOME") ?? `${Deno.env.get("HOME")}/.rustup`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      CARGO_NET_GIT_FETCH_WITH_CLI: "false",
    };
    await Deno.mkdir(trustedEnv.HOME);
    const fetched = await command(
      "cargo",
      ["fetch", "--locked", "--manifest-path", `${root}/Cargo.toml`],
      empty,
      trustedEnv,
      context.signal,
    );
    if (!fetched.success)
      throw new Error(
        `locked dependency acquisition failed: ${new TextDecoder().decode(fetched.stderr).slice(-2000)}`,
      );
    transcript.push(
      "locked dependencies acquired from empty working directory",
    );
    stage = "bwrap availability check";
    const bwrap = await command(
      "bwrap",
      ["--version"],
      empty,
      { PATH: trustedEnv.PATH },
      context.signal,
    );
    if (!bwrap.success)
      throw new Error("bwrap is mandatory for preview execution");
    const sysroot = await output(
      "rustc",
      ["--print", "sysroot"],
      empty,
      context,
    );
    await Deno.writeTextFile(`${work}/canary.sh`, probeScript);
    await Promise.all([
      Deno.writeTextFile(`${scratch}/credential-sentinel`, "must stay hidden"),
      Deno.writeTextFile(`${scratch}/filesystem-sentinel`, "must stay hidden"),
    ]);
    stage = "sandbox control probes";
    const probes = await command(
      "bwrap",
      [
        ...previewSandboxArgs(root, cargoHome, sysroot, work),
        "--clearenv",
        "--setenv",
        "PATH",
        "/rust/bin:/usr/bin:/bin",
        "--setenv",
        "CARGO_HOME",
        "/cargo",
        "--setenv",
        "CREDENTIAL_SENTINEL",
        `${scratch}/credential-sentinel`,
        "--setenv",
        "FILESYSTEM_SENTINEL",
        `${scratch}/filesystem-sentinel`,
        "/bin/sh",
        "/work/canary.sh",
      ],
      empty,
      { PATH: trustedEnv.PATH },
      context.signal,
    );
    sandboxEvidence.bwrap = probes.success;
    const markerExists = async (name: string) => {
      try {
        return (await Deno.stat(`${work}/${name}`)).isFile;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    };
    sandboxEvidence.credentialsHidden =
      await markerExists("credentials-hidden");
    sandboxEvidence.filesystemSentinelHidden = await markerExists(
      "filesystem-sentinel-hidden",
    );
    sandboxEvidence.noEgress = (
      await Promise.all(
        [
          "dns-denied",
          "https-denied",
          "private-network-denied",
          "metadata-denied",
        ].map(markerExists),
      )
    ).every(Boolean);
    if (!probes.success) throw new Error("sandbox control probes failed");
    transcript.push(
      "sandbox credential, filesystem, and no-egress probes passed",
    );
    await Deno.remove(`${work}/canary.sh`);
    await Deno.mkdir(`${work}/home`);
    stage = "sandboxed offline build";
    build = "failed";
    const built = await command(
      "bwrap",
      [
        ...previewSandboxArgs(root, cargoHome, sysroot, work),
        "--clearenv",
        "--setenv",
        "PATH",
        "/rust/bin:/usr/bin:/bin",
        "--setenv",
        "HOME",
        "/work/home",
        "--setenv",
        "XDG_CONFIG_HOME",
        "/work/home/config",
        "--setenv",
        "XDG_DATA_HOME",
        "/work/home/data",
        "--setenv",
        "XDG_CACHE_HOME",
        "/work/home/cache",
        "--setenv",
        "XDG_RUNTIME_DIR",
        "/work/run",
        "--setenv",
        "TMPDIR",
        "/tmp",
        "--setenv",
        "CARGO_HOME",
        "/cargo",
        "--setenv",
        "RUSTC",
        "/rust/bin/rustc",
        "/bin/sh",
        "-c",
        "mkdir -p /work/home/config /work/home/data /work/home/cache /work/run /work/target && /rust/bin/cargo build --locked --offline --manifest-path /src/Cargo.toml --target-dir /work/target --bin herdr",
      ],
      empty,
      { PATH: trustedEnv.PATH },
      context.signal,
    );
    if (!built.success) throw new Error("sandboxed offline build failed");
    build = "passed";
    if ((await sha256(`${root}/Cargo.lock`)) !== lock)
      throw new Error("Cargo.lock changed during canary");
    transcript.push("cargo --locked --offline completed inside bwrap");
    status = "passed";
  } catch {
    errorMessage = `${stage} failed`;
    transcript.push(errorMessage);
  } finally {
    try {
      await Deno.remove(scratch, { recursive: true });
      cleanupCompleted = true;
    } catch {
      status = "failed";
      errorMessage = errorMessage
        ? `${errorMessage}; cleanup failed`
        : "cleanup failed";
      transcript.push("cleanup failed");
    }
  }
  const result: z.infer<typeof PreviewCanaryResult> = {
    status,
    repository,
    tag: args.expectedTag,
    commit,
    tree,
    cargoLockSha256: lock,
    sourceClean: true,
    build,
    sandbox: sandboxEvidence,
    transcript,
    cleanupCompleted,
    error: errorMessage,
    startedAt: new Date(started).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
  const handle = await context.writeResource(
    "preview-canary-result",
    "preview-canary-result",
    result,
  );
  if (result.status === "failed")
    throw new Error(result.error ?? "preview canary failed");
  return { dataHandles: [handle] };
}

async function runChecks(
  resourceName: string,
  commands: Array<{ name: string; args: string[] }>,
  expectedGitHead: string,
  root: string,
  context: Context,
) {
  const started = Date.now();
  const checks: z.infer<typeof Check>[] = [];
  const gitHead = await output("git", ["rev-parse", "HEAD"], root, context);
  if (gitHead !== expectedGitHead) {
    throw new Error(`expected HEAD ${expectedGitHead}, found ${gitHead}`);
  }
  if (await output("git", ["status", "--porcelain"], root, context)) {
    throw new Error("Rust verification requires a clean worktree");
  }
  const evidence = {
    gitHead,
    cargoLockSha256: await sha256(`${root}/Cargo.lock`),
    cargoVersion: await output("cargo", ["--version"], root, context),
    rustcVersion: await output("rustc", ["--version"], root, context),
    platform: `${Deno.build.os}-${Deno.build.arch}`,
    startedAt: new Date(started).toISOString(),
  };

  for (const command of commands) {
    const startedAt = performance.now();
    let output;
    try {
      const timeout = AbortSignal.timeout(45 * 60 * 1000);
      output = await new Deno.Command("cargo", {
        args: command.args,
        cwd: root,
        env: environment(),
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
        signal: context.signal
          ? AbortSignal.any([context.signal, timeout])
          : timeout,
      }).output();
    } catch (error) {
      checks.push({
        name: command.name,
        status: "failed",
        durationMs: Math.round(performance.now() - startedAt),
      });
      const detail = error instanceof Error ? error.message : String(error);
      await context.writeResource("result", resourceName, {
        status: "failed",
        checks,
        error: detail,
        ...evidence,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      });
      throw new Error(`${command.name} failed: ${detail}`);
    }
    const status = output.success ? "passed" : "failed";
    checks.push({
      name: command.name,
      status,
      durationMs: Math.round(performance.now() - startedAt),
    });

    if (!output.success) {
      const decoder = new TextDecoder();
      const detail = [
        decoder.decode(output.stdout),
        decoder.decode(output.stderr),
      ]
        .filter(Boolean)
        .join("\n")
        .trim()
        .slice(-8000);
      await context.writeResource("result", resourceName, {
        status,
        checks,
        error: detail || undefined,
        ...evidence,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      });
      throw new Error(`${command.name} failed${detail ? `: ${detail}` : ""}`);
    }
  }

  const finalHead = await output("git", ["rev-parse", "HEAD"], root, context);
  if (
    finalHead !== expectedGitHead ||
    (await output("git", ["status", "--porcelain"], root, context))
  ) {
    throw new Error("repository changed during Rust verification");
  }
  const handle = await context.writeResource("result", resourceName, {
    status: "passed",
    checks,
    ...evidence,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  });
  return { dataHandles: [handle] };
}

/** Project-specific Rust verification model. */
export const model = {
  type: "@funsaized/herdr-mise-rust",
  version: "2026.09.12.1",
  globalArguments: GlobalArguments,
  resources: {
    result: {
      description: "Structured Rust verification result",
      schema: Result,
      lifetime: "30d",
      garbageCollection: 20,
    },
    "preview-canary-result": {
      description:
        "Sanitized source-built Herdr preview compatibility evidence",
      schema: PreviewCanaryResult,
      lifetime: "7d",
      garbageCollection: 8,
    },
  },
  methods: {
    fallbackAssets: {
      description:
        "Test the Rust workspace after removing generated client assets",
      arguments: VerifyArguments,
      execute: async (
        args: z.infer<typeof VerifyArguments>,
        context: Context,
      ) => {
        const root = await subjectRoot(context.repoDir, args.subjectRoot);
        const dist = await subjectPath(root, "client/dist");
        try {
          const info = await Deno.lstat(dist);
          if (info.isSymlink)
            throw new Error("client/dist must not be a symlink");
          await Deno.remove(dist, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        return await runChecks(
          "fallback-assets-result",
          [
            {
              name: "test-fallback-assets",
              args: ["test", "--workspace", "--locked"],
            },
          ],
          args.expectedGitHead,
          root,
          context,
        );
      },
    },
    verify: {
      description: "Run Rust formatting, checking, and production-assets tests",
      arguments: VerifyArguments,
      execute: async (
        args: z.infer<typeof VerifyArguments>,
        context: Context,
      ) => {
        const root = await subjectRoot(context.repoDir, args.subjectRoot);
        return await runChecks(
          "verification-result",
          [
            { name: "format", args: ["fmt", "--all", "--check"] },
            { name: "check", args: ["check", "--workspace", "--locked"] },
            {
              name: "clippy",
              args: [
                "clippy",
                "--workspace",
                "--all-targets",
                "--locked",
                "--",
                "-D",
                "warnings",
              ],
            },
            { name: "test", args: ["test", "--workspace", "--locked"] },
          ],
          args.expectedGitHead,
          root,
          context,
        );
      },
    },
    previewCanary: {
      description:
        "Build and probe a pinned Herdr preview in mandatory bwrap isolation",
      arguments: PreviewArguments,
      execute: previewCanary,
    },
  },
};
