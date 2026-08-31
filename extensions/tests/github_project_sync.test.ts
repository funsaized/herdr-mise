import {
  FACTORY_STAGES,
  projectSyncResourceName,
  resolveStatusField,
} from "../models/github_project_sync.ts";

function rejects(operation: () => unknown, message: string) {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw error;
  }
  throw new Error("expected operation to reject");
}

Deno.test("Project 2 requires every exact factory stage once", () => {
  const options = FACTORY_STAGES.map((name, index) => ({
    id: `option-${index}`,
    name,
  }));
  const resolved = resolveStatusField([
    { id: "status", name: "Status", options },
  ]);
  if (resolved.optionIds["plan-review"] !== "option-1") {
    throw new Error("status option was not resolved");
  }

  rejects(
    () =>
      resolveStatusField([
        { id: "status", name: "Status", options: options.slice(1) },
      ]),
    "planning",
  );
  rejects(
    () =>
      resolveStatusField([
        {
          id: "status",
          name: "Status",
          options: [...options, { id: "duplicate", name: "planning" }],
        },
      ]),
    "found 2",
  );
});

Deno.test("single-item project syncs have isolated result names", () => {
  const item = { issueNumber: 67, stageId: "planning" as const };
  if (projectSyncResourceName([item]) !== "project-sync-67") {
    throw new Error("single-item result is not isolated");
  }
  if (
    projectSyncResourceName([item, { ...item, issueNumber: 68 }]) !==
    "project-sync"
  ) {
    throw new Error("fleet result name changed");
  }
});
