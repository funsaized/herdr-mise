import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  cp,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseLastJson } from "./lib/swamp-test-process.mjs";

test("legacy empty selections permit downstream jobs in the real Swamp runtime", async () => {
  const repo = await mkdtemp(join(tmpdir(), "nightshift-empty-selection-"));
  function run(args) {
    const result = spawnSync("swamp", [...args, "--json", "--no-color"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return parseLastJson(result.stdout);
  }
  try {
    run(["repo", "init", "--tool", "none"]);
    const created = run(["workflow", "create", "empty-selection"]);
    const path = created.path;
    const source = await readFile(path, "utf8");
    const id = source.match(/^id: .+$/mu)[0];
    await writeFile(
      path,
      `${id}
name: empty-selection
jobs:
  - name: optional-tests
    steps:
      - name: test-\${{ self.entry }}
        forEach:
          item: entry
          in: '\${{ [] }}'
        task:
          type: assert
          expr: 'false'
          message: Empty selection must not execute a test
          severity: high
  - name: downstream
    steps:
      - name: proceeds
        task:
          type: assert
          expr: 'true'
          message: Legacy plans retain downstream execution
          severity: high
    dependsOn:
      - { job: optional-tests, condition: { type: succeeded } }
version: 1
`,
    );
    run(["workflow", "validate", "empty-selection"]);
    const result = run([
      "workflow",
      "run",
      "empty-selection",
      "--timeout",
      "20s",
    ]);
    assert.equal(result.status, "succeeded");
    assert.equal(
      result.jobs.find((job) => job.name === "downstream").steps[0].status,
      "succeeded",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test(
  "approved plans execute and collect real Rust receipts through the production DAG",
  { timeout: 180000 },
  async () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const repo = await mkdtemp(
      join(tmpdir(), "nightshift-approved-selection-"),
    );
    function run(args, input, success = true) {
      const result = spawnSync("swamp", [...args, "--json", "--no-color"], {
        cwd: repo,
        encoding: "utf8",
        input: input && JSON.stringify(input),
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (
        success &&
        result.status !== 0 &&
        (args[1] === "method" || args[1] === "run")
      ) {
        const workflow = args[0] === "workflow";
        const report = spawnSync(
          "swamp",
          [
            "report",
            "get",
            workflow ? "@swamp/workflow-summary" : "@swamp/method-summary",
            workflow ? "--workflow" : "--model",
            workflow ? args[2] : args[3],
            "--json",
          ],
          { cwd: repo, encoding: "utf8" },
        );
        result.stderr += `\nFailure report: ${report.stdout} ${report.stderr}`;
      }
      if (success)
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      else {
        assert.notEqual(result.status, 0);
        return result;
      }
      return parseLastJson(result.stdout);
    }
    function command(exe, args) {
      const result = spawnSync(exe, args, { cwd: repo, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }
    const method = (name, input = {}, success = true) =>
      run(
        ["model", "method", "run", "selection-fixture", name, "--stdin"],
        { workItem: "901", ...input },
        success,
      );
    try {
      run(["repo", "init", "--tool", "none"]);
      const lock = JSON.parse(
        await readFile(
          join(root, "extensions/models/upstream_extensions.json"),
          "utf8",
        ),
      );
      const factory = lock["@swamp/software-factory"];
      await mkdir(join(repo, "extensions/models"), { recursive: true });
      await writeFile(
        join(repo, "extensions/models/upstream_extensions.json"),
        JSON.stringify({ "@swamp/software-factory": factory }),
      );
      for (const path of factory.files) {
        assert.ok(!path.startsWith("/") && !path.split("/").includes(".."));
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await cp(
          join(process.env.SWAMP_TEST_EXTENSION_REPO ?? root, path),
          join(repo, path),
          { recursive: true },
        );
      }
      run(["extension", "install"]);
      for (const file of [
        "nightshift_test_selection.ts",
        "rust_test_receipt.ts",
        "test_receipt.ts",
        "subject_process.ts",
        "stored_test_receipt.ts",
        "subject_root.ts",
        "herdr_mise_rust.ts",
        "verification_evidence.ts",
      ])
        await copyFile(
          join(root, "extensions/models", file),
          join(repo, "extensions/models", file),
        );
      await mkdir(join(repo, "workflows"), { recursive: true });
      for (const name of ["nightshift-run-tests", "nightshift-test-receipt"])
        await copyFile(
          join(root, "workflows", `workflow-${name}.yaml`),
          join(repo, "workflows", `workflow-${name}.yaml`),
        );
      const stages = [
        {
          id: "planning",
          initial: true,
          artifacts: [
            {
              name: "plan",
              schema: { type: "object", additionalProperties: true },
            },
          ],
          transitions: [
            {
              name: "submit",
              to: "plan-review",
              gates: [
                { type: "artifact-exists", config: { artifact: "plan" } },
              ],
            },
          ],
        },
        {
          id: "plan-review",
          artifacts: [
            { name: "plan-review", kind: "findings", reviews: "plan" },
          ],
          transitions: [
            {
              name: "build",
              to: "building",
              gates: [
                { type: "human-approval", config: { id: "plan-approval" } },
              ],
            },
          ],
        },
        { id: "building", terminal: true },
      ];
      // Building is active, as in the production lifecycle; this fixture never ships.
      stages[2] = {
        id: "building",
        transitions: [{ name: "done", to: "done", gates: [] }],
      };
      stages.push({ id: "done", terminal: true });
      run([
        "model",
        "create",
        "@swamp/software-factory",
        "selection-fixture",
        "--global-arg",
        `stages=${JSON.stringify(stages)}`,
      ]);
      await mkdir(join(repo, "src"));
      await writeFile(
        join(repo, "Cargo.toml"),
        '[package]\nname="herdr-mise-server"\nversion="0.1.0"\nedition="2021"\n',
      );
      await writeFile(
        join(repo, "src/lib.rs"),
        "#[test] fn proof() { assert_eq!(2 + 2, 4); }\n",
      );
      await writeFile(join(repo, ".gitignore"), ".swamp/\ntarget/\n");
      command("cargo", ["generate-lockfile", "--offline"]);
      command("git", ["init"]);
      command("git", ["add", "."]);
      command("git", [
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
      const expectedGitHead = command("git", ["rev-parse", "HEAD"]);
      method("start");
      method("record_artifact", {
        name: "plan",
        payload: {
          testSelection: [{ runner: "rust", target: "lib", selector: "proof" }],
        },
      });
      method("advance", { transition: "submit" });
      method("record_artifact", {
        name: "plan-review",
        payload: { findings: [] },
      });
      const args = {
        factory: "selection-fixture",
        workItem: "901",
        subjectRoot: repo,
        expectedGitHead,
        runId: "fixture-build",
      };
      method("prepare_test_selection", args, false);
      // Explicit fixture approval, confined to this disposable test repository.
      method("approve", { gateId: "plan-approval", actor: "test-fixture" });
      method("advance", { transition: "build" });
      run(["workflow", "validate", "nightshift-run-tests"]);
      const result = run(
        ["workflow", "run", "nightshift-run-tests", "--stdin"],
        args,
      );
      assert.equal(result.status, "succeeded");
      const stored = run([
        "data",
        "query",
        'modelName == "selection-fixture" && name == "test-evidence"',
        "--select",
        "attributes",
      ]);
      assert.equal(stored.results[0].receipts.length, 1);
      assert.equal(stored.results[0].receipts[0].counts.passed, 1);
      await writeFile(
        join(repo, "src/lib.rs"),
        '#[test] fn proof() { panic!("changed"); }\n',
      );
      method("record_test_results", args, false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);
