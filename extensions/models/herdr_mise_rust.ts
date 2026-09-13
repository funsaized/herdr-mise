/** Runs the repository's deterministic Rust verification controls. */
import { z } from "npm:zod@4.4.3";
import { subjectPath, subjectRoot } from "./subject_root.ts";
import {
  readRegularFile,
  sha256 as sha256Bytes,
} from "./verification_evidence.ts";

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
  runCommand?: (
    executable: string,
    options: Deno.CommandOptions,
  ) => Promise<Deno.CommandOutput>;
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
  repository: z.literal("https://github.com/herdrdev/herdr.git").optional(),
  tag: z.string(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  tree: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  cargoLockSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
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
  const options: Deno.CommandOptions = {
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
  };
  const result = context.runCommand
    ? await context.runCommand(command, options)
    : await new Deno.Command(command, options).output();
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
  context: Context,
) {
  const timeout = AbortSignal.timeout(45 * 60 * 1000);
  const options: Deno.CommandOptions = {
    args,
    cwd,
    env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: context.signal
      ? AbortSignal.any([context.signal, timeout])
      : timeout,
  };
  const result = context.runCommand
    ? await context.runCommand(executable, options)
    : await new Deno.Command(executable, options).output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim().slice(-2000);
    throw new Error(
      `${executable} exited with code ${result.code}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return result;
}

export function previewSandboxArgs(
  source: string,
  cargoHome: string,
  rustSysroot: string,
  scratch: string,
  options: { allowNetwork?: boolean; writableCargoHome?: boolean } = {},
) {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(!options.allowNetwork ? ["--unshare-net"] : []),
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
    "--ro-bind",
    rustSysroot,
    "/rust",
    "--bind",
    scratch,
    "/work",
    "--chdir",
    "/work",
  ];
  if (options.writableCargoHome) {
    args.push("--bind", cargoHome, "/cargo");
  } else {
    args.push("--dir", "/cargo");
  }
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
  if (options.allowNetwork) {
    for (const path of [
      "/etc/ssl",
      "/etc/resolv.conf",
      "/etc/hosts",
      "/etc/nsswitch.conf",
    ]) {
      try {
        Deno.statSync(path);
        args.push("--ro-bind", path, path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
  return args;
}

export function previewCanaryFailure(
  stage: string,
  error: unknown,
  privatePaths: string[] = [],
) {
  let detail = error instanceof Error ? error.message : String(error);
  for (const path of privatePaths
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    detail = detail.replaceAll(path, "<redacted-path>");
  return `${stage} failed${detail ? `: ${detail.slice(-2000)}` : ""}`;
}

export function assertPublicLockedDependencies(lockfile: string) {
  const canonical =
    'source = "registry+https://github.com/rust-lang/crates.io-index"';
  for (const line of lockfile.split("\n")) {
    if (line === canonical) continue;
    if (
      /^\s*(?:(?:[\w-]+|"[^"]*"|'[^']*')\s*\.\s*)*(?:source(?=[\s=.]|$)|["']source["'])/.test(
        line,
      ) ||
      /[{,]\s*(?:source(?=[\s=.]|$)|["']source["'])/.test(line)
    )
      throw new Error("Cargo.lock contains an unsupported dependency source");
  }
}

export const previewProbeScript = String.raw`
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

export async function previewCanary(
  args: z.infer<typeof PreviewArguments>,
  context: Context,
) {
  const started = Date.now();
  let root: string | undefined;
  let repository: string | undefined;
  let commit: string | undefined;
  let tree: string | undefined;
  let lock: string | undefined;
  let scratch: string | undefined;
  let status: "passed" | "failed" = "failed";
  let build: "passed" | "failed" | "unavailable" = "unavailable";
  let stage = "source identity verification";
  let errorMessage: string | undefined;
  let sysroot: string | undefined;
  let sourceClean = false;
  let cleanupCompleted = false;
  const transcript: string[] = [];
  const sandboxEvidence = {
    bwrap: false,
    noEgress: false,
    credentialsHidden: false,
    filesystemSentinelHidden: false,
  };
  try {
    root = await subjectRoot(context.repoDir, args.sourceRoot);
    const runGit = (gitArgs: string[]) =>
      output("git", gitArgs, root!, context);
    repository = await runGit(["remote", "get-url", "origin"]);
    if (repository !== "https://github.com/herdrdev/herdr.git")
      throw new Error("unexpected preview remote");
    commit = await runGit(["rev-parse", "HEAD"]);
    const tagCommit = await runGit([
      "rev-parse",
      `refs/tags/${args.expectedTag}^{commit}`,
    ]);
    if (commit !== args.expectedCommit || tagCommit !== args.expectedCommit)
      throw new Error(
        "preview tag and HEAD do not match the discovered commit",
      );
    tree = await runGit(["rev-parse", "HEAD^{tree}"]);
    if (await runGit(["status", "--porcelain", "--untracked-files=all"]))
      throw new Error("preview checkout is not clean");
    stage = "initial Cargo.lock verification";
    const lockfile = await readRegularFile(root, "Cargo.lock");
    assertPublicLockedDependencies(new TextDecoder().decode(lockfile));
    lock = await sha256Bytes(lockfile);
    sourceClean = true;
    transcript.push("source identity verified");
    scratch = await Deno.makeTempDir({ prefix: "herdr-preview-canary-" });
    const cargoHome = `${scratch}/cargo-home`;
    const empty = `${scratch}/empty`;
    const work = `${scratch}/work`;
    await Promise.all([cargoHome, empty, work].map((path) => Deno.mkdir(path)));
    const trustedEnv = { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" };
    stage = "bwrap availability check";
    await command(
      "bwrap",
      ["--version"],
      empty,
      { PATH: trustedEnv.PATH },
      context,
    );
    stage = "Rust toolchain discovery";
    sysroot = await output("rustc", ["--print", "sysroot"], empty, context);
    stage = "sandboxed dependency acquisition";
    await command(
      "bwrap",
      [
        ...previewSandboxArgs(root, cargoHome, sysroot, work, {
          allowNetwork: true,
          writableCargoHome: true,
        }),
        "--chdir",
        "/work",
        "--clearenv",
        "--setenv",
        "PATH",
        "/rust/bin:/usr/bin:/bin",
        "--setenv",
        "HOME",
        "/work",
        "--setenv",
        "CARGO_HOME",
        "/cargo",
        "/rust/bin/cargo",
        "fetch",
        "--locked",
        "--manifest-path",
        "/src/Cargo.toml",
        "--config",
        'registries.crates-io.index="sparse+https://index.crates.io/"',
      ],
      empty,
      { PATH: trustedEnv.PATH },
      context,
    );
    transcript.push(
      "locked dependencies acquired from empty working directory",
    );
    stage = "sandbox probe setup";
    await Deno.writeTextFile(`${work}/canary.sh`, previewProbeScript);
    await Promise.all([
      Deno.writeTextFile(`${scratch}/credential-sentinel`, "must stay hidden"),
      Deno.writeTextFile(`${scratch}/filesystem-sentinel`, "must stay hidden"),
    ]);
    stage = "sandbox control probes";
    await command(
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
      context,
    );
    sandboxEvidence.bwrap = true;
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
    if (!Object.values(sandboxEvidence).every(Boolean))
      throw new Error("sandbox isolation evidence incomplete");
    transcript.push(
      "sandbox credential, filesystem, and no-egress probes passed",
    );
    await Deno.remove(`${work}/canary.sh`);
    await Deno.mkdir(`${work}/home`);
    stage = "sandboxed offline build";
    build = "failed";
    await command(
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
      context,
    );
    build = "passed";
    stage = "final Cargo.lock integrity verification";
    if ((await sha256Bytes(await readRegularFile(root, "Cargo.lock"))) !== lock)
      throw new Error("Cargo.lock changed during canary");
    transcript.push("cargo --locked --offline completed inside bwrap");
    status = "passed";
  } catch (error) {
    errorMessage = previewCanaryFailure(stage, error, [
      root ?? "",
      scratch ?? "",
      context.repoDir,
      Deno.env.get("HOME") ?? "",
      Deno.env.get("RUSTUP_HOME") ?? "",
      sysroot ?? "",
    ]);
    transcript.push(errorMessage);
  } finally {
    try {
      if (scratch) await Deno.remove(scratch, { recursive: true });
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
    repository:
      repository === "https://github.com/herdrdev/herdr.git"
        ? repository
        : undefined,
    tag: args.expectedTag,
    commit,
    tree,
    cargoLockSha256: lock,
    sourceClean,
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
  version: "2026.09.12.2",
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
