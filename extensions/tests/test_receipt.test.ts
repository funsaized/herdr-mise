import { sourceDigest, testCounts } from "../models/test_receipt.ts";
import { extension } from "../models/npm_subject.ts";

Deno.test("test receipts reject zero, failed, malformed and ambiguous test summaries", () => {
  const tap = (passed: number) =>
    `# tests ${passed}\n# pass ${passed}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  if (testCounts(tap(2), "node-tap").passed !== 2)
    throw new Error("Passing count lost");
  for (const output of [
    tap(0),
    tap(1) + tap(1),
    "probe",
    tap(2).replace("# fail 0", "# fail 1"),
  ]) {
    let failed = false;
    try {
      testCounts(output, "node-tap");
    } catch {
      failed = true;
    }
    if (!failed) throw new Error("Invalid TAP evidence accepted");
  }
  const vitest = {
    success: true,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTotalTests: 1,
  };
  if (
    testCounts(`npm banner\n${JSON.stringify(vitest)}`, "vitest-json")
      .selected !== 1
  )
    throw new Error("JSON reporter not parsed");
  if (
    testCounts(
      JSON.stringify({
        stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 1 },
        errors: [],
      }),
      "playwright-json",
    ).skipped !== 1
  )
    throw new Error("Skipped count lost");
  let failed = false;
  try {
    testCounts(
      JSON.stringify({
        stats: { expected: 2, unexpected: 0, flaky: 1, skipped: 0 },
      }),
      "playwright-json",
    );
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("Flaky execution claimed clean");
});

Deno.test("actual npm test receipts bind uncommitted source and detect mutations and empty selection", async () => {
  const root = await Deno.makeTempDir({ prefix: "receipt-test-" });
  const git = async (...args: string[]) => {
    const result = await new Deno.Command("git", {
      args,
      cwd: root,
      stdout: "piped",
      stderr: "piped",
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).output();
    if (!result.success)
      throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    await Deno.writeTextFile(
      `${root}/package.json`,
      JSON.stringify({
        name: "receipt-fixture",
        scripts: { test: "node --test" },
      }),
    );
    await Deno.writeTextFile(`${root}/package-lock.json`, "{}");
    await Deno.writeTextFile(
      `${root}/behavior.test.mjs`,
      "import test from 'node:test'; test('fixture boundary', () => {});\n",
    );
    await git("init");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "fixture",
    );
    const head = await git("rev-parse", "HEAD");
    const original = await sourceDigest(root);
    await Deno.writeTextFile(`${root}/untracked.txt`, "uncommitted");
    const dirty = await sourceDigest(root);
    if (original === dirty) throw new Error("Untracked source excluded");
    const resources = new Map<string, Record<string, unknown>>();
    const run = Object.assign({}, ...extension.methods).test_subject.execute;
    const context = {
      repoDir: root,
      globalArgs: {
        projectDir: ".",
        lifecycleScripts: "deny" as const,
        allowedScripts: ["test"],
        environment: {},
        defaultTimeoutMs: 30000,
        requireCleanGit: false,
      },
      createFileWriter: () => ({
        writeLine: async () => {},
        finalize: async () => ({ name: "durable-log" }),
      }),
      writeResource: async (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        resources.set(spec, data);
        return { name };
      },
    };
    const args = {
      subjectRoot: root,
      expectedGitHead: head,
      script: "test",
      args: [],
      reporter: "node-tap" as const,
    };
    await run(args, context);
    const receipt = resources.get("testReceipt")!;
    if (
      receipt.sourceDigestBefore !== dirty ||
      receipt.sourceDigestAfter !== dirty ||
      receipt.executionStatus !== "succeeded" ||
      receipt.logName !== "durable-log" ||
      (receipt.counts as { passed: number }).passed !== 1
    )
      throw new Error("Receipt omitted source/count/log identity");
    const verify = Object.assign({}, ...extension.methods).verify_test_receipt
      .execute;
    const verifyContext = {
      ...context,
      modelType: "@funsaized/npm/project",
      modelId: "fixture",
      dataRepository: {
        getContent: async () =>
          new TextEncoder().encode(JSON.stringify(receipt)),
      },
    };
    const verifyArgs = {
      subjectRoot: root,
      expectedGitHead: head,
      receiptName: "test-receipt-1-aaaaaaaa",
    };
    await verify(verifyArgs, verifyContext);
    await Deno.writeTextFile(`${root}/untracked.txt`, "stale");
    let staleRejected = false;
    try {
      await verify(verifyArgs, verifyContext);
    } catch {
      staleRejected = true;
    }
    if (!staleRejected) throw new Error("Receipt survived a source change");
    await Deno.writeTextFile(
      `${root}/behavior.test.mjs`,
      "import test from 'node:test'; import {writeFileSync} from 'node:fs'; test('mutates', () => writeFileSync('untracked.txt','changed'));\n",
    );
    for (const empty of [false, true]) {
      if (empty) await Deno.remove(`${root}/behavior.test.mjs`);
      let failed = false;
      try {
        await run(args, context);
      } catch {
        failed = true;
      }
      if (!failed || resources.get("testReceipt")?.executionStatus !== "failed")
        throw new Error("Invalid execution produced a successful receipt");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
