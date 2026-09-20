/** Exact Rust test selection with persisted source-bound execution evidence. */
import { z } from "npm:zod@4.4.3";
import { sourceDigest, testCounts } from "./test_receipt.ts";
import { subjectRoot } from "./subject_root.ts";
import { runLogged, type FileWriter } from "./subject_process.ts";
import {
  verifyTestReceipt,
  type ReceiptContext,
} from "./stored_test_receipt.ts";

const Identity = z.object({
  expectedGitHead: z.string().regex(/^[0-9a-f]{40}$/),
  subjectRoot: z.string().min(1),
});
const Selection = Identity.extend({
  target: z.enum(["lib", "integration"]),
  targetName: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/)
    .optional(),
  testName: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_:]*$/),
}).superRefine((args, ctx) => {
  if ((args.target === "integration") !== (args.targetName !== undefined))
    ctx.addIssue({
      code: "custom",
      message: "Only integration tests require targetName",
    });
});
type Context = ReceiptContext & {
  createFileWriter(
    spec: string,
    name: string,
    options: { streaming: boolean },
  ): FileWriter;
};

export function rustTestArguments(input: z.infer<typeof Selection>) {
  const args = Selection.parse(input);
  return [
    "test",
    "--locked",
    "--color",
    "never",
    "--package",
    "herdr-mise-server",
    ...(args.target === "lib" ? ["--lib"] : ["--test", args.targetName!]),
    args.testName,
    "--",
    "--exact",
    "--color",
    "never",
  ];
}

export async function executeRustTest(
  args: z.infer<typeof Selection>,
  context: Context,
) {
  const startedAt = new Date().toISOString();
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const name = `test-receipt-${suffix}`;
  const argv = ["cargo", ...rustTestArguments(args)];
  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    reporter: "rust-libtest",
    operation: "test",
    argv,
    startedAt,
    expectedGitHead: args.expectedGitHead,
    gitHeadBefore: null,
    gitHeadAfter: null,
    sourceDigestBefore: null,
    sourceDigestAfter: null,
    counts: null,
    exitCode: null,
    logName: null,
    invocationName: `test-invocation-${suffix}`,
    subjectRoot: args.subjectRoot,
    platform: `${Deno.build.os}-${Deno.build.arch}`,
  };
  let log: FileWriter | undefined;
  let failure: unknown;
  const errors: string[] = [];
  const remember = (error: unknown) => {
    failure ??= error;
    errors.push(error instanceof Error ? error.message : String(error));
  };
  try {
    log = context.createFileWriter("testLog", `test-log-${suffix}`, {
      streaming: true,
    });
    const root = await subjectRoot(context.repoDir, args.subjectRoot);
    receipt.subjectRoot = root;
    const env = Object.fromEntries(
      ["PATH", "HOME", "CARGO_HOME", "RUSTUP_HOME", "TMPDIR"].flatMap((key) =>
        Deno.env.get(key) === undefined ? [] : [[key, Deno.env.get(key)!]],
      ),
    );
    Object.assign(env, {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    const capture = async (executable: string, arguments_: string[]) => {
      const result = await new Deno.Command(executable, {
        args: arguments_,
        cwd: root,
        env,
        clearEnv: true,
        signal: context.signal,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!result.success) throw new Error(`${executable} preflight failed`);
      return new TextDecoder().decode(result.stdout).trim();
    };
    receipt.gitHeadBefore = await capture("git", ["rev-parse", "HEAD"]);
    if (receipt.gitHeadBefore !== args.expectedGitHead)
      throw new Error("Rust test subject HEAD mismatch");
    receipt.cargoVersion = await capture("cargo", ["--version"]);
    receipt.rustcVersion = await capture("rustc", ["--version"]);
    receipt.sourceDigestBefore = await sourceDigest(root, context.signal);
    let output = "";
    receipt.exitCode = await runLogged(
      "cargo",
      argv.slice(1),
      root,
      env,
      15 * 60 * 1000,
      log,
      context.signal,
      (text) => {
        output += text;
      },
    );
    receipt.gitHeadAfter = await capture("git", ["rev-parse", "HEAD"]);
    receipt.sourceDigestAfter = await sourceDigest(root, context.signal);
    if (
      receipt.gitHeadBefore !== receipt.gitHeadAfter ||
      receipt.sourceDigestBefore !== receipt.sourceDigestAfter
    )
      throw new Error("Rust tests changed source identity");
    if (receipt.exitCode !== 0)
      throw new Error(`Rust test exited ${receipt.exitCode}`);
    receipt.counts = testCounts(output, "rust-libtest");
  } catch (error) {
    remember(error);
  }
  let logHandle: { name: string } | undefined;
  if (log) {
    try {
      if (errors.length) await log.writeLine(`[error] ${errors.join("; ")}`);
      logHandle = await log.finalize();
      receipt.logName = logHandle.name;
    } catch (error) {
      remember(error);
    }
  }
  Object.assign(receipt, {
    executionStatus: errors.length ? "failed" : "succeeded",
    error: errors.length ? errors.join("; ") : null,
    completedAt: new Date().toISOString(),
  });
  const invocation = await context.writeResource(
    "testInvocation",
    String(receipt.invocationName),
    receipt,
  );
  const handle = await context.writeResource("testReceipt", name, receipt);
  const pointer = await context.writeResource(
    "testReceiptPointer",
    "test-result",
    {
      receiptName: name,
      executionStatus: receipt.executionStatus,
    },
  );
  if (failure) throw failure;
  return { dataHandles: [invocation, handle, logHandle!, pointer] };
}

export const rustReceiptResources = {
  testReceiptPointer: {
    description:
      "Latest produced or verified test receipt for workflow bindings",
    schema: z.record(z.string(), z.unknown()),
    lifetime: "30d",
    garbageCollection: 100,
  },
  testReceipt: {
    description: "Source-bound exact Rust test receipt or receipt verification",
    schema: z.record(z.string(), z.unknown()),
    lifetime: "30d",
    garbageCollection: 100,
  },
  testInvocation: {
    description: "Observed exact Rust test invocation including failures",
    schema: z.record(z.string(), z.unknown()),
    lifetime: "30d",
    garbageCollection: 100,
  },
};
export const rustReceiptFiles = {
  testLog: {
    description: "Bounded Rust test stdout/stderr",
    contentType: "text/plain",
    lifetime: "30d",
    garbageCollection: 100,
    streaming: true,
  },
};
export const rustReceiptMethods = {
  test_subject: {
    description: "Run one exact Rust test with source-bound nonempty proof",
    arguments: Selection,
    execute: executeRustTest,
  },
  verify_test_receipt: {
    description: "Verify persisted Rust proof against current source identity",
    arguments: Identity.extend({
      receiptName: z.string().regex(/^test-receipt-[0-9]+-[a-f0-9]{8}$/),
    }),
    execute: verifyTestReceipt,
  },
};
