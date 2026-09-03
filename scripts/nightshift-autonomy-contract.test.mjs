import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const planFanout = readFileSync(
  "workflows/workflow-nightshift-plan-fanout.yaml",
  "utf8",
);
const factory = readFileSync(
  "models/@swamp/software-factory/the-nightshift.yaml",
  "utf8",
);

test("Nightshift planning fan-out serializes canonical unique work items", () => {
  assert.match(planFanout, /minItems: 1/);
  assert.match(planFanout, /maxItems: 100/);
  assert.match(planFanout, /uniqueItems: true/);
  assert.ok(planFanout.includes("pattern: '^[0-9]+$'"));
  assert.match(planFanout, /maxLength: 16/);
  assert.match(
    planFanout,
    /forEach:\n\s+item: workItem\n\s+in: \$\{\{ inputs\.workItems \}\}/,
  );
  assert.match(planFanout, /concurrency: 1/);
  assert.match(planFanout, /workflowIdOrName: nightshift-plan/);
  assert.ok(planFanout.includes("issueNumber: ${{ int(self.workItem) }}"));
  assert.match(planFanout, /^\s+reviewFeedback: \$\{\{/m);
  assert.match(planFanout, /^\s+currentPlan: \$\{\{/m);
  assert.match(planFanout, /^\s+humanFeedback: '\$\{\{/m);
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
