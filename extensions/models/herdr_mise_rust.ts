/** Runs the repository's deterministic Rust verification controls. */
import { z } from "npm:zod@4.4.3";

const GlobalArguments = z.object({});
const VerifyArguments = z.object({
  expectedGitHead: z.string().regex(/^[0-9a-f]{40}$/),
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
  completedAt: z.iso.datetime(),
});

async function output(command: string, args: string[], context: Context) {
  const result = await new Deno.Command(command, {
    args,
    cwd: context.repoDir,
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

async function runChecks(
  resourceName: string,
  commands: Array<{ name: string; args: string[] }>,
  expectedGitHead: string,
  context: Context,
) {
  const checks: z.infer<typeof Check>[] = [];
  const gitHead = await output("git", ["rev-parse", "HEAD"], context);
  if (gitHead !== expectedGitHead) {
    throw new Error(`expected HEAD ${expectedGitHead}, found ${gitHead}`);
  }
  if (await output("git", ["status", "--porcelain"], context)) {
    throw new Error("Rust verification requires a clean worktree");
  }
  const evidence = {
    gitHead,
    cargoLockSha256: await sha256(`${context.repoDir}/Cargo.lock`),
    cargoVersion: await output("cargo", ["--version"], context),
    rustcVersion: await output("rustc", ["--version"], context),
    platform: `${Deno.build.os}-${Deno.build.arch}`,
  };

  for (const command of commands) {
    const startedAt = performance.now();
    let output;
    try {
      const timeout = AbortSignal.timeout(45 * 60 * 1000);
      output = await new Deno.Command("cargo", {
        args: command.args,
        cwd: context.repoDir,
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
      });
      throw new Error(`${command.name} failed${detail ? `: ${detail}` : ""}`);
    }
  }

  const finalHead = await output("git", ["rev-parse", "HEAD"], context);
  if (
    finalHead !== expectedGitHead ||
    (await output("git", ["status", "--porcelain"], context))
  ) {
    throw new Error("repository changed during Rust verification");
  }
  const handle = await context.writeResource("result", resourceName, {
    status: "passed",
    checks,
    ...evidence,
    completedAt: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}

/** Project-specific Rust verification model. */
export const model = {
  type: "@funsaized/herdr-mise-rust",
  version: "2026.08.27.1",
  globalArguments: GlobalArguments,
  resources: {
    result: {
      description: "Structured Rust verification result",
      schema: Result,
      lifetime: "30d",
      garbageCollection: 20,
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
        try {
          await Deno.remove(`${context.repoDir}/client/dist`, {
            recursive: true,
          });
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
      ) =>
        await runChecks(
          "verification-result",
          [
            { name: "format", args: ["fmt", "--all", "--check"] },
            { name: "check", args: ["check", "--workspace", "--locked"] },
            { name: "test", args: ["test", "--workspace", "--locked"] },
          ],
          args.expectedGitHead,
          context,
        ),
    },
  },
};
