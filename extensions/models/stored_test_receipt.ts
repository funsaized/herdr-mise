/** Verify persisted evidence against the current source, never caller JSON. */
import { z } from "npm:zod@4.4.3";
import { sourceDigest } from "./test_receipt.ts";
import { subjectRoot } from "./subject_root.ts";
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
export type ReceiptContext = {
  repoDir: string;
  signal?: AbortSignal;
  modelId?: string;
  modelType?: string;
  dataRepository?: {
    getContent(
      type: string,
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
async function capture(
  executable: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
) {
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    env,
    clearEnv: true,
    signal,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(`${executable} identity check failed`);
  return new TextDecoder().decode(result.stdout).trim();
}
export async function verifyTestReceipt(
  args: { expectedGitHead: string; subjectRoot: string; receiptName: string },
  context: ReceiptContext,
) {
  if (!context.dataRepository || !context.modelId || !context.modelType)
    throw new Error("Stored receipt repository unavailable");
  const bytes = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    args.receiptName,
  );
  if (!bytes) throw new Error("Stored test receipt not found on this model");
  const receipt = z
    .object({
      schemaVersion: z.literal(1),
      executionStatus: z.literal("succeeded"),
      exitCode: z.literal(0),
      gitHeadBefore: Sha,
      gitHeadAfter: Sha,
      sourceDigestBefore: z.string().regex(/^[a-f0-9]{64}$/),
      sourceDigestAfter: z.string().regex(/^[a-f0-9]{64}$/),
      counts: z.object({
        passed: z.number().int().positive(),
        failed: z.literal(0),
        selected: z.number().int().positive(),
      }),
      logName: z.string().min(1),
      invocationName: z.string().min(1),
    })
    .passthrough()
    .parse(JSON.parse(new TextDecoder().decode(bytes)));
  const root = await subjectRoot(context.repoDir, args.subjectRoot);
  const env = {
    PATH: Deno.env.get("PATH") ?? "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const head = await capture(
    "git",
    ["rev-parse", "HEAD"],
    root,
    env,
    context.signal,
  );
  const digest = await sourceDigest(root, context.signal);
  if (
    head !== args.expectedGitHead ||
    receipt.gitHeadBefore !== head ||
    receipt.gitHeadAfter !== head ||
    receipt.sourceDigestBefore !== digest ||
    receipt.sourceDigestAfter !== digest ||
    receipt.counts.selected !== receipt.counts.passed
  )
    throw new Error("Stale or inconsistent test receipt");
  const handle = await context.writeResource(
    "testReceipt",
    `verified-${args.receiptName}`,
    {
      ...receipt,
      receiptName: args.receiptName,
      verifiedAt: new Date().toISOString(),
      subjectRoot: root,
    },
  );
  const pointer = await context.writeResource(
    "testReceiptPointer",
    "verified-test-result",
    {
      ...receipt,
      receiptName: args.receiptName,
      verifiedAt: new Date().toISOString(),
      subjectRoot: root,
    },
  );
  return { dataHandles: [handle, pointer] };
}
