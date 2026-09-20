import { extension as selectionExtension } from "../models/nightshift_test_selection.ts";
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
    const factoryRecords = new Map<string, Record<string, unknown>>();
    const stamp = new Date().toISOString();
    factoryRecords.set("state-245", {
      workItem: "245",
      stageId: "building",
      status: "active",
      cycles: { planning: 1, "plan-review": 1 },
    });
    factoryRecords.set("artifact-245-plan", {
      workItem: "245",
      name: "plan",
      stageId: "planning",
      cycle: 1,
      recordedAt: stamp,
      payload: {
        testSelection: [{ runner: "rust", target: "lib", selector: "proof" }],
      },
    });
    factoryRecords.set("artifact-245-plan-review", {
      workItem: "245",
      name: "plan-review",
      stageId: "plan-review",
      cycle: 1,
      subjectVersion: 1,
      recordedAt: stamp,
    });
    factoryRecords.set("approval-245-plan-approval", {
      workItem: "245",
      gateId: "plan-approval",
      stageId: "plan-review",
      cycle: 1,
      decision: "approved",
      decidedAt: stamp,
    });
    const factoryContext = {
      repoDir: root,
      modelType: "@swamp/software-factory",
      modelId: "factory",
      definitionRepository: {
        findByNameGlobal: async () => ({
          definition: { id: "fixture" },
          type: { normalized: "@funsaized/herdr-mise-rust" },
        }),
      },
      dataRepository: {
        findAllForModel: async () =>
          [...factoryRecords.keys()].map((name) => ({ name, version: 1 })),
        getContent: async (_type: unknown, id: string, name: string) => {
          const record = (id === "factory" ? factoryRecords : resources).get(
            name,
          );
          return record
            ? new TextEncoder().encode(JSON.stringify(record))
            : null;
        },
      },
      writeResource: async (
        _spec: string,
        name: string,
        value: Record<string, unknown>,
      ) => {
        factoryRecords.set(name, value);
        return { name };
      },
    };
    const buildArgs = {
      workItem: "245",
      runId: "build-1",
      subjectRoot: root,
      expectedGitHead: head,
    };
    const prepare =
      selectionExtension.methods[0].prepare_test_selection!.execute;
    const collect = selectionExtension.methods[1].record_test_results!.execute;
    await prepare(buildArgs, factoryContext);
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
    await collect(buildArgs, factoryContext);
    if (
      (factoryRecords.get("test-evidence")?.receipts as unknown[] | undefined)
        ?.length !== 1
    )
      throw new Error("Approved selection did not collect persisted proof");
    const rejectCollection = async () => {
      let rejected = false;
      try {
        await collect(buildArgs, factoryContext);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("Invalid selected receipt accepted");
    };
    const pointer = resources.get("verified-test-result")!;
    resources.set("verified-test-result", {
      ...pointer,
      argv: ["cargo", "--help"],
    });
    await rejectCollection();
    resources.set("verified-test-result", {
      ...pointer,
      startedAt: "2000-01-01T00:00:00Z",
    });
    await rejectCollection();
    resources.set("verified-test-result", pointer);
    const approval = factoryRecords.get("approval-245-plan-approval")!;
    factoryRecords.set("approval-245-plan-approval", {
      ...approval,
      decision: "rejected",
    });
    await rejectCollection();
    factoryRecords.set("approval-245-plan-approval", approval);
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
      "--allow-empty",
      "-m",
      "same bytes new identity",
    ]);
    await rejectCollection();
    await command("git", ["reset", "--soft", head]);
    await collect(buildArgs, factoryContext);
    await Deno.writeTextFile(`${root}/untracked.txt`, "new source");
    let staleRejected = false;
    try {
      await verifyTestReceipt(verifyArgs, context);
    } catch {
      staleRejected = true;
    }
    await rejectCollection();
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
