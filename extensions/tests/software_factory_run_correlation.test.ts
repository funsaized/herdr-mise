import { checkCorrelatedWorkflowRun } from "../models/software_factory_run_correlation.ts";

const encoder = new TextEncoder();

function context(expectedRunId: string, summaryRunIds: string[]) {
  const records = new Map<string, unknown>([
    [
      "state-67",
      {
        stageId: "planning",
        cycles: { planning: 1 },
        enteredAt: "2026-08-30T00:00:00Z",
      },
    ],
    [
      "evidence-67-planning-run",
      {
        stageId: "planning",
        cycle: 1,
        payload: { status: "succeeded", runId: expectedRunId },
      },
    ],
  ]);
  return {
    globalArgs: {
      stages: [
        {
          id: "planning",
          work: {
            mode: "workflow",
            workflow: { name: "nightshift-plan" },
            resultEvidence: "planning-run",
          },
          transitions: [
            {
              name: "submit",
              gates: [
                {
                  type: "evidence-recorded",
                  config: {
                    name: "planning-run",
                    requireField: { status: "succeeded" },
                  },
                },
                { type: "artifact-exists", config: { artifact: "plan" } },
              ],
            },
          ],
        },
      ],
    },
    modelType: "@swamp/software-factory",
    modelId: "factory-id",
    definition: { name: "the-nightshift" },
    unresolvedMethodArgs: { workItem: "67", transition: "submit" },
    dataRepository: {
      findAllForModel: async () =>
        [...records.keys()].map((name) => ({ name, version: 1 })),
      getContent: async (_type: string, _id: string, name: string) => {
        const value = records.get(name);
        return value === undefined
          ? null
          : encoder.encode(JSON.stringify(value));
      },
    },
    queryData: async (predicate: string) =>
      predicate.includes('name == "artifact-67-plan"')
        ? [{}]
        : summaryRunIds.map((workflowRunId) => ({
            content: {
              status: "succeeded",
              workflowName: "nightshift-plan",
              workflowRunId,
            },
            createdAt: "2026-08-30T00:01:00Z",
          })),
  };
}

Deno.test("workflow evidence accepts only its exact successful run", async () => {
  const exact = await checkCorrelatedWorkflowRun(
    context("run-67", ["run-68", "run-67"]),
  );
  if (!exact.pass) throw new Error(exact.errors?.join("\n"));

  const sibling = await checkCorrelatedWorkflowRun(
    context("run-67", ["run-68"]),
  );
  if (sibling.pass || !sibling.errors?.[0].includes("found 0")) {
    throw new Error("a sibling workflow run satisfied the gate");
  }
});
