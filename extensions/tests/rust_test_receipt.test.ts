import {
  executeRustTest,
  rustTestArguments,
} from "../models/rust_test_receipt.ts";
import { testCounts } from "../models/test_receipt.ts";
import { verifyTestReceipt } from "../models/stored_test_receipt.ts";

Deno.test("Rust selection rejects command flags and ambiguous reporter summaries", () => {
  const identity = { expectedGitHead: "a".repeat(40), subjectRoot: "." };
  for (const selection of [
    { target: "lib" as const, testName: "--ignored" },
    {
      target: "integration" as const,
      targetName: "--all-targets",
      testName: "proof",
    },
    { target: "lib" as const, targetName: "cli", testName: "proof" },
  ]) {
    let rejected = false;
    try {
      rustTestArguments({ ...identity, ...selection });
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw new Error("Unsafe or contradictory test selection accepted");
  }
  const summary =
    "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.01s\n";
  if (testCounts(summary, "rust-libtest").passed !== 1)
    throw new Error("Passing count lost");
  for (const output of [
    summary + summary,
    summary.replace("1 passed", "0 passed"),
    summary.replace("0 failed", "1 failed"),
    "",
    summary.replace("0 measured", "1 measured"),
  ]) {
    let rejected = false;
    try {
      testCounts(output, "rust-libtest");
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Invalid Rust proof accepted");
  }
});

Deno.test("real Cargo receipts reject empty, ignored, failed, mutated and stale subjects", async () => {
  const root = await Deno.makeTempDir({ prefix: "rust-receipt-" });
  const command = async (exe: string, args: string[]) => {
    const result = await new Deno.Command(exe, {
      args,
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success)
      throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    await Deno.mkdir(`${root}/src`);
    await Deno.writeTextFile(`${root}/.gitignore`, "/target/\n");
    await Deno.writeTextFile(
      `${root}/Cargo.toml`,
      '[package]\nname="herdr-mise-server"\nversion="0.1.0"\nedition="2021"\n',
    );
    await Deno.writeTextFile(
      `${root}/src/lib.rs`,
      `
      #[test] fn proof() { assert_eq!(2 + 2, 4); }
      #[test] fn failure() { panic!("real failure"); }
      #[test] #[ignore] fn ignored() {}
      #[test] fn mutation() { std::fs::write("untracked.txt", "changed").unwrap(); }
    `,
    );
    await command("cargo", ["generate-lockfile", "--offline"]);
    await command("git", ["init"]);
    await command("git", ["add", "."]);
    await command("git", [
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
    ]);
    const head = await command("git", ["rev-parse", "HEAD"]);
    await Deno.writeTextFile(`${root}/untracked.txt`, "uncommitted source");
    const resources = new Map<string, Record<string, unknown>>();
    const context = {
      repoDir: root,
      modelType: "@funsaized/herdr-mise-rust",
      modelId: "fixture",
      createFileWriter: () => ({
        writeLine: async () => {},
        finalize: async () => ({ name: "stored-log" }),
      }),
      writeResource: async (
        spec: string,
        name: string,
        value: Record<string, unknown>,
      ) => {
        resources.set(spec, value);
        resources.set(name, value);
        return { name };
      },
      dataRepository: {
        getContent: async (_type: string, _id: string, name: string) => {
          const value = resources.get(name);
          return value ? new TextEncoder().encode(JSON.stringify(value)) : null;
        },
      },
    };
    const args = {
      subjectRoot: root,
      expectedGitHead: head,
      target: "lib" as const,
      testName: "proof",
    };
    const result = await executeRustTest(args, context);
    const receipt = resources.get("testReceipt")!;
    if (
      receipt.executionStatus !== "succeeded" ||
      receipt.sourceDigestBefore !== receipt.sourceDigestAfter ||
      (receipt.counts as { passed: number }).passed !== 1
    )
      throw new Error("Real test receipt omitted identity or count");
    const verifyArgs = {
      subjectRoot: root,
      expectedGitHead: head,
      receiptName: result.dataHandles[1].name,
    };
    await verifyTestReceipt(verifyArgs, context);
    await Deno.writeTextFile(`${root}/untracked.txt`, "new source");
    let staleRejected = false;
    try {
      await verifyTestReceipt(verifyArgs, context);
    } catch {
      staleRejected = true;
    }
    if (!staleRejected) throw new Error("Stale Rust proof accepted");
    for (const testName of ["absent", "ignored", "failure", "mutation"]) {
      let failed = false;
      try {
        await executeRustTest({ ...args, testName }, context);
      } catch {
        failed = true;
      }
      if (!failed || resources.get("testReceipt")?.executionStatus !== "failed")
        throw new Error(`Invalid Rust execution accepted: ${testName}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
