import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const planFanout = readFileSync(
  "workflows/workflow-nightshift-plan-fanout.yaml",
  "utf8",
);
const buildFanout = readFileSync(
  "workflows/workflow-nightshift-build-fanout.yaml",
  "utf8",
);
const factory = readFileSync(
  "models/@swamp/software-factory/the-nightshift.yaml",
  "utf8",
);
const template = readFileSync(
  "models/@swamp/software-factory/nightshift-template.yaml",
  "utf8",
);
const factoryWorkflows = [
  "plan",
  "build",
  "review",
  "ship",
  "close",
  "cleanup",
  "deployed-verification",
  "record-failure",
].map((name) => [
  name,
  readFileSync(`workflows/workflow-nightshift-${name}.yaml`, "utf8"),
]);
const nightshiftModes = readFileSync(
  ".agents/skills/software-factory/references/nightshift-modes.md",
  "utf8",
);
const repairWorkflow = readFileSync(
  "workflows/workflow-nightshift-factory-repair.yaml",
  "utf8",
);

const fanoutMapsToFactory =
  /forEach:\n\s+item: entry\n\s+in: '\$\{\{ inputs\.workItems\.map\(/;
const item77Routing =
  '"factory": w == "77" ? "the-nightshift" : "nightshift-run-" + w';

test("Nightshift planning fan-out maps each work item to one factory and serializes", () => {
  assert.match(planFanout, /minItems: 1/);
  assert.match(planFanout, /maxItems: 100/);
  assert.match(planFanout, /uniqueItems: true/);
  assert.ok(planFanout.includes("pattern: '^[1-9][0-9]*$'"));
  assert.match(planFanout, /maxLength: 16/);
  assert.match(planFanout, fanoutMapsToFactory);
  assert.ok(planFanout.includes(item77Routing));
  assert.match(planFanout, /concurrency: 1/);
  assert.match(planFanout, /workflowIdOrName: nightshift-plan/);
  assert.match(planFanout, /factory: \$\{\{ self\.entry\.factory \}\}/);
  assert.match(planFanout, /workItem: \$\{\{ self\.entry\.workItem \}\}/);
  assert.ok(
    planFanout.includes("issueNumber: ${{ int(self.entry.workItem) }}"),
  );
  assert.match(
    planFanout,
    /reviewFeedback: \$\{\{ data\.latest\(self\.entry\.factory/,
  );
  assert.match(
    planFanout,
    /currentPlan: \$\{\{ data\.latest\(self\.entry\.factory/,
  );
  assert.match(
    planFanout,
    /humanFeedback: '\$\{\{ data\.latest\(self\.entry\.factory/,
  );
});

test("Nightshift build fan-out maps each work item to one factory with two builders", () => {
  assert.match(buildFanout, fanoutMapsToFactory);
  assert.ok(buildFanout.includes(item77Routing));
  assert.match(buildFanout, /concurrency: 2/);
  assert.match(buildFanout, /workflowIdOrName: nightshift-build/);
  assert.match(buildFanout, /factory: \$\{\{ self\.entry\.factory \}\}/);
  assert.match(buildFanout, /workItem: \$\{\{ self\.entry\.workItem \}\}/);
  assert.match(buildFanout, /plan: \$\{\{ data\.latest\(self\.entry\.factory/);
  assert.match(
    buildFanout,
    /reviewFeedback: \$\{\{ data\.latest\(self\.entry\.factory/,
  );
});

test("Nightshift resident driver takes a fleet census and dispatches from fresh per-item status", () => {
  assert.match(
    nightshiftModes,
    /modelType == "@swamp\/software-factory" && name\.startsWith\("state-"\)/,
  );
  assert.match(nightshiftModes, /\(modelName, modelId, workItem\)/);
  assert.match(nightshiftModes, /status --input workItem=/);
  assert.match(nightshiftModes, /terminal[^\n]*active dispatch/i);
  assert.match(nightshiftModes, /retain[^\n]*history/i);
  assert.match(nightshiftModes, /Never[^\n]*status-_factory/i);
});

test("Nightshift repair is explicit and analytics stays off status paths", () => {
  assert.match(repairWorkflow, /enum: \[repair\]/u);
  assert.match(repairWorkflow, /modelType: '@swamp\/software-factory'/u);
  assert.match(repairWorkflow, /modelName: \$\{\{ inputs\.modelName \}\}/u);
  assert.match(
    repairWorkflow,
    /model\.nightshift-template\.definition\.globalArguments/u,
  );
  assert.match(
    factory,
    /name: "@funsaized\/nightshift-factory-analytics",\n\s+methods: \[summary\]/u,
  );
});

test("Nightshift template is the legacy lifecycle snapshot without runtime reports", () => {
  const legacyLifecycle = factory.slice(
    factory.indexOf("globalArguments:\n"),
    factory.indexOf("reports:\n"),
  );
  const templateLifecycle = template.slice(
    template.indexOf("globalArguments:\n"),
    template.indexOf("methods: {}\n"),
  );
  assert.equal(templateLifecycle, legacyLifecycle);
  assert.doesNotMatch(template, /^reports:/mu);
});

test("Nightshift workflows keep factory reads and writes on one explicit owner", () => {
  for (const [name, workflow] of factoryWorkflows) {
    assert.match(workflow, /required: \[factory,/u, `${name} requires factory`);
    assert.doesNotMatch(workflow, /modelIdOrName: the-nightshift/u);
    assert.doesNotMatch(workflow, /data\.latest\("the-nightshift"/u);
    assert.doesNotMatch(workflow, /skipChecks|skip-check/u);
  }
  assert.equal(factory.match(/factory: "\$\{\{ self\.name \}\}"/gu)?.length, 8);
});

test("Nightshift parks fresh failed review rounds at cycle four", () => {
  for (const [id, next] of [
    ["plan-review", "plan-feedback"],
    ["code-review", "parked"],
  ]) {
    const stage = factory.slice(
      factory.indexOf(`        - id: ${id}\n`),
      factory.indexOf(`        - id: ${next}\n`),
    );
    const rework = stage.slice(
      stage.indexOf("              - name: rework\n"),
      stage.indexOf("              - name: park\n"),
    );
    const park = stage.slice(
      stage.indexOf("              - name: park\n"),
      stage.indexOf("              - name: retry\n"),
    );

    assert.match(stage, /maxCycles: 4/);
    assert.match(rework, /recordedThisCycle: true/);
    assert.match(rework, /round:fail/);
    assert.ok(rework.includes(`config: { stage: ${id}, limit: 4 }`));
    assert.doesNotMatch(rework, /invert:/);
    assert.match(park, /recordedThisCycle: true/);
    assert.match(park, /round:fail/);
    assert.ok(
      park.includes(`config: { stage: ${id}, limit: 4, invert: true }`),
    );
  }

  const parked = factory.slice(
    factory.indexOf("        - id: parked\n"),
    factory.indexOf("        - id: ship-prep\n"),
  );
  assert.doesNotMatch(parked, /^\s+work:/m);
  assert.match(parked, /id: rework-parked/);
  assert.match(parked, /id: rework-parked-build/);
  assert.match(parked, /artifact: change-summary/);
  assert.doesNotMatch(parked, /override-ship/);
  assert.doesNotMatch(parked, /to: ship-prep/);

  const globalTransitions = factory.slice(
    factory.indexOf("    globalTransitions:\n"),
  );
  assert.match(
    globalTransitions,
    /name: abort\n\s+to: abort-cleanup[\s\S]+id: abort-confirmation/,
  );
});

test("Nightshift ships from an isolated clean worktree", () => {
  const ship = readFileSync("workflows/workflow-nightshift-ship.yaml", "utf8");
  assert.match(ship, /methodName: prepare_workspace/);
  assert.match(ship, /herdr-mise-ship-/);
  assert.match(ship, /nightshift\/ship-/);
  assert.match(
    ship,
    /methodName: require_issue_link[\s\S]*?commit: \$\{{\s*inputs\.commit\s*}}/,
  );
  assert.doesNotMatch(ship, /artifact-release-candidate/);
  assert.doesNotMatch(ship, /subjectRoot: \$\{{\s*inputs\.subjectRoot\s*}}/);
});

test("Nightshift sends ship-prep feedback through build and code review", () => {
  const building = factory.slice(
    factory.indexOf("        - id: building\n"),
    factory.indexOf("        - id: code-review\n"),
  );
  const shipPrep = factory.slice(
    factory.indexOf("        - id: ship-prep\n"),
    factory.indexOf("        - id: shipping\n"),
  );

  assert.match(building, /artifact-ship-feedback/);
  assert.match(building, /subjectVersion/);
  assert.match(shipPrep, /name: ship-feedback/);
  assert.match(shipPrep, /name: release-candidate\n\s+reviews: change-summary/);
  assert.match(shipPrep, /reviews: release-candidate/);
  assert.match(
    shipPrep,
    /name: request-rework\n\s+to: building\n\s+manual: true/,
  );
  assert.match(shipPrep, /artifact: ship-feedback, recordedThisCycle: true/);
  assert.match(
    shipPrep,
    /artifact: release-candidate,[\s\S]+recordedThisCycle: true/,
  );
});
