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

test(
  "only an approved code review reaches ship-prep, and review stays capped",
  { timeout: 60_000 },
  () => {
    const { stages } = swamp([
      "model",
      "get",
      "nightshift-template",
    ]).globalArguments;
    const byId = Object.fromEntries(stages.map((stage) => [stage.id, stage]));
    const into = (target) =>
      stages.flatMap((stage) =>
        (stage.transitions ?? [])
          .filter(
            (transition) => transition.to === target && stage.id !== target,
          )
          .map((transition) => `${stage.id}.${transition.name}`),
      );
    assert.deepEqual(into("ship-prep"), ["code-review.approve"]);
    assert.deepEqual(into("shipping"), ["ship-prep.ship"]);
    const approve = byId["code-review"].transitions.find(
      (t) => t.name === "approve",
    );
    assert.ok(approve.gates.some((gate) => gate.type === "findings-clear"));
    for (const review of ["plan-review", "code-review"]) {
      assert.equal(byId[review].maxCycles, 4, review);
      const cap = (gate) =>
        gate.type === "max-cycles" &&
        gate.config.stage === review &&
        gate.config.limit === 4 &&
        !gate.config.invert;
      assert.ok(
        byId[review].transitions
          .find((t) => t.name === "rework")
          .gates.some(cap),
      );
      const exit = review === "plan-review" ? "rework-plan" : "rework-build";
      assert.ok(
        byId.parked.transitions.find((t) => t.name === exit).gates.some(cap),
        exit,
      );
    }
    const ship = readFileSync(
      "workflows/workflow-nightshift-ship.yaml",
      "utf8",
    );
    assert.match(ship, /methodName: require_managed_verification/);
    assert.match(ship, /methodName: require_issue_link/);
  },
);

// Intake may overlap a running factory (see AGENTS.md), so it must stay
// metadata-only: issue creation and lifecycle start. Runtime factories are
// created by scripts/nightshift-start-factory.mjs, never from workflow data.
test(
  "parallel intake workflows stay metadata-only",
  { timeout: 60_000 },
  () => {
    const allowed = new Set([
      "model_method:nightshift-github.create_issue",
      "model_method:nightshift-issues.start",
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

// Swamp runs steps in dependency waves and steps sharing a model wait on its
// lock for at most 60s, so two steps on one model must never share a wave.
test(
  "verification never schedules two steps on one model in a wave",
  { timeout: 60_000 },
  () => {
    const steps = swamp(["workflow", "get", "verification"]).jobs.flatMap(
      (job) => job.steps,
    );
    const byName = Object.fromEntries(steps.map((step) => [step.name, step]));
    const wave = new Map();
    const level = (name) => {
      if (!wave.has(name))
        wave.set(
          name,
          1 +
            Math.max(
              0,
              ...byName[name].dependsOn.map((dep) => level(dep.step)),
            ),
        );
      return wave.get(name);
    };
    const seen = new Set();
    for (const step of steps) {
      const key = `${level(step.name)}:${step.task.modelIdOrName}`;
      assert.ok(!seen.has(key), `${step.name} shares wave ${key}`);
      seen.add(key);
    }
  },
);
