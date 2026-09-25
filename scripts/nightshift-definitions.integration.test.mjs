import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { parseLastJson } from "./lib/swamp-test-process.mjs";

// Factory definitions are validated by the real Swamp runtime rather than by
// matching YAML text; only invariants Swamp cannot express are asserted here.
// Validation runs in a scratch copy because restoring pinned extensions
// rewrites tracked skill files, and subjects must stay clean.
const repo = mkdtempSync(join(tmpdir(), "nightshift-definitions-"));
before(
  () => {
    for (const path of [".swamp.yaml", "extensions", "models", "workflows"])
      cpSync(path, join(repo, path), { recursive: true });
    swamp(["extension", "install"]);
  },
  { timeout: 300_000 },
);
after(() => rmSync(repo, { recursive: true, force: true }));

function swamp(args) {
  const result = spawnSync("swamp", [...args, "--json", "--no-color"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return parseLastJson(result.stdout);
}

test(
  "every Swamp workflow passes runtime validation",
  { timeout: 60_000 },
  () => {
    const declared = readdirSync("workflows")
      .filter((name) => name.endsWith(".yaml"))
      .map(
        (name) =>
          readFileSync(`workflows/${name}`, "utf8").match(/^name: (\S+)$/m)[1],
      )
      .sort();
    const report = swamp(["workflow", "validate"]);
    const validated = new Set(
      report.workflows.map((workflow) => workflow.workflowName),
    );
    assert.deepEqual(
      declared.filter((name) => !validated.has(name)),
      [],
    );
    assert.deepEqual(
      report.workflows
        .filter((workflow) =>
          workflow.validations.some((check) => !check.passed),
        )
        .map((workflow) => workflow.workflowName),
      [],
    );
  },
);

test(
  "the Nightshift factory template passes its own graph validation",
  { timeout: 60_000 },
  () => {
    const result = swamp([
      "model",
      "method",
      "run",
      "nightshift-template",
      "validate",
    ]);
    assert.equal(result.status, "succeeded");
  },
);

// Intake may overlap a running factory (see AGENTS.md), so it must stay
// metadata-only: issue creation, lifecycle start, and a direct factory start.
test(
  "parallel intake workflows stay metadata-only",
  { timeout: 60_000 },
  () => {
    const allowed = new Set([
      "model_method:nightshift-github.create_issue",
      "model_method:nightshift-issues.start",
      "model_method:@swamp/software-factory.start",
      "workflow:nightshift-intake",
    ]);
    for (const name of ["nightshift-create-intake", "nightshift-intake"]) {
      const source = readFileSync(`workflows/workflow-${name}.yaml`, "utf8");
      assert.doesNotMatch(source, /skipChecks|skip-check/u, name);
      for (const job of swamp(["workflow", "get", name]).jobs) {
        for (const { task } of job.steps) {
          if (task.type === "assert") continue;
          const target =
            task.type === "workflow"
              ? task.workflowIdOrName
              : `${task.modelType ?? task.modelIdOrName}.${task.methodName}`;
          assert.ok(
            allowed.has(`${task.type}:${target}`),
            `${name}: ${task.type}:${target}`,
          );
        }
      }
    }
  },
);
