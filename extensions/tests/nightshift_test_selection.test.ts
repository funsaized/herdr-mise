import {
  compileTestSelection,
  requireApprovedPlan,
} from "../models/nightshift_test_selection.ts";

function rejects(fn: () => unknown) {
  let rejected = false;
  try {
    fn();
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Invalid selection or approval accepted");
}
const args = {
  workItem: "245",
  runId: "build-1",
  subjectRoot: ".",
  expectedGitHead: "a".repeat(40),
};
Deno.test("approved test selection uses bounded literal names and preserves legacy plans", () => {
  if (compileTestSelection(undefined, args).length)
    throw new Error("Legacy plan acquired fabricated tests");
  const entries = compileTestSelection(
    [
      { runner: "node", selector: "fixture [a].*" },
      { runner: "vitest", selector: "rejects invalid input" },
      { runner: "playwright", selector: "keyboard navigation" },
      {
        runner: "rust",
        target: "integration",
        targetName: "cli",
        selector: "diagnostic",
      },
    ],
    args,
  );
  if (
    JSON.stringify(entries[0].expectedArgv) !==
    JSON.stringify([
      "npm",
      "run",
      "test:unit",
      "--",
      "--test-name-pattern=^fixture \\[a\\]\\.\\*$",
      "--test-reporter=tap",
    ])
  )
    throw new Error("Node literal name was not escaped and anchored");
  if (!entries[3].expectedArgv.includes("--exact"))
    throw new Error("Rust selection was not exact");
  for (const selection of [
    [],
    [{ runner: "shell", selector: "echo pass" }],
    [{ runner: "rust", target: "lib", selector: "--ignored" }],
    [{ runner: "node", selector: "proof", target: "lib" }],
    [{ runner: "node", selector: "proof\n--help" }],
    [{ runner: "node", selector: "proof", command: "echo pass" }],
  ])
    rejects(() => compileTestSelection(selection, args));
});
Deno.test("selection requires the reviewed version and human approval for the current cycle", () => {
  const state = {
    workItem: "245",
    stageId: "building",
    status: "active",
    cycles: { planning: 2, "plan-review": 3 },
  };
  const plan = {
    version: 4,
    attributes: {
      workItem: "245",
      name: "plan",
      stageId: "planning",
      cycle: 2,
      recordedAt: "2026-09-20T10:00:00Z",
    },
  };
  const review = {
    workItem: "245",
    name: "plan-review",
    stageId: "plan-review",
    cycle: 3,
    subjectVersion: 4,
    recordedAt: "2026-09-20T10:01:00Z",
  };
  const approval = {
    workItem: "245",
    gateId: "plan-approval",
    stageId: "plan-review",
    cycle: 3,
    decision: "approved",
    decidedAt: "2026-09-20T10:02:00Z",
  };
  requireApprovedPlan("245", state, plan, review, approval);
  for (const altered of [
    { ...approval, decision: "rejected" },
    { ...approval, cycle: 2 },
    { ...approval, workItem: "246" },
    { ...approval, decidedAt: "2026-09-20T10:00:30Z" },
  ])
    rejects(() => requireApprovedPlan("245", state, plan, review, altered));
  rejects(() =>
    requireApprovedPlan(
      "245",
      state,
      { ...plan, version: 5 },
      review,
      approval,
    ),
  );
  rejects(() =>
    requireApprovedPlan(
      "245",
      { ...state, stageId: "code-review" },
      plan,
      review,
      approval,
    ),
  );
  rejects(() =>
    requireApprovedPlan(
      "245",
      { ...state, cycles: {} },
      plan,
      review,
      approval,
    ),
  );
  rejects(() =>
    requireApprovedPlan(
      "245",
      state,
      plan,
      { ...review, name: "code-review" },
      approval,
    ),
  );
});
