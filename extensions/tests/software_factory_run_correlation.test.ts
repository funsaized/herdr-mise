import {
  checkCorrelatedWorkflowRun,
  checkNightshiftFactoryIdentity,
} from "../models/software_factory_run_correlation.ts";

const encoder = new TextEncoder();

function context(
  expectedRunId: string,
  summaryRunIds: string[],
  status: "succeeded" | "failed" = "succeeded",
  summaryStatus: "succeeded" | "failed" = status,
) {
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
        payload: { status, runId: expectedRunId },
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
                    requireField: { status },
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
    methodName: "advance",
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
    queryData: async (predicate: string) => {
      if (predicate.includes('name == "artifact-67-plan"')) {
        if (!predicate.includes("version > 0")) {
          throw new Error("artifact query did not request history");
        }
        return [{}];
      }
      if (!predicate.includes("version > 0")) {
        throw new Error("workflow summary query did not request history");
      }
      return summaryRunIds.map((workflowRunId) => ({
        content: {
          status: summaryStatus,
          workflowName: "nightshift-plan",
          workflowRunId,
        },
        createdAt: "2026-08-30T00:01:00Z",
      }));
    },
  };
}

const workItemMethods = [
  "start",
  "status",
  "record_dispatch",
  "record_artifact",
  "record_evidence",
  "resolve_findings",
  "approve",
  "reject",
  "advance",
  "summary",
  "reset",
];

function identityContext(
  name: string,
  workItem: string,
  methodName: string,
  stateStatus: "active" | "terminal" = "active",
  otherOwner = false,
) {
  return {
    globalArgs: {},
    modelType: "@swamp/software-factory",
    modelId: "current-factory-id",
    methodName,
    definition: { name },
    unresolvedMethodArgs: { workItem },
    dataRepository: {
      findAllForModel: async () => [{ name: `state-${workItem}`, version: 1 }],
      getContent: async () =>
        encoder.encode(JSON.stringify({ workItem, status: stateStatus })),
    },
    queryData: async () =>
      otherOwner
        ? [
            {
              name: `state-${workItem}`,
              version: 1,
              modelId: "other-factory-id",
            },
          ]
        : [],
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

  const failed = await checkCorrelatedWorkflowRun(
    context("failed-67", ["failed-67"], "failed"),
  );
  if (!failed.pass) throw new Error(failed.errors?.join("\n"));

  const mismatchedStatus = await checkCorrelatedWorkflowRun(
    context("failed-67", ["failed-67"], "failed", "succeeded"),
  );
  if (mismatchedStatus.pass) {
    throw new Error(
      "a workflow summary with the wrong status satisfied the gate",
    );
  }
});

Deno.test("workflow correlation resolves an auto-definition name by model ID", async () => {
  const base = context("run-67", ["run-67"]);
  const { definition: _definition, ...withoutDefinition } = base;
  const result = await checkCorrelatedWorkflowRun({
    ...withoutDefinition,
    definitionRepository: {
      findById: async () => ({
        name: "nightshift-run-67",
        globalArguments: base.globalArgs,
      }),
    },
    queryData: async (predicate: string) => {
      if (
        predicate.includes('name == "artifact-67-plan"') &&
        !predicate.includes('modelName == "nightshift-run-67"')
      ) {
        throw new Error("artifact query was not scoped to the runtime model");
      }
      return base.queryData(predicate);
    },
  });
  if (!result.pass) throw new Error(result.errors?.join("\n"));
});

Deno.test("Nightshift template and runtime identity fail closed", async () => {
  const named = identityContext("nightshift-run-132", "132", "status");
  const { definition: _definition, ...missingDefinition } = named;
  const unknown = await checkNightshiftFactoryIdentity(missingDefinition);
  if (unknown.pass) throw new Error("missing factory identity failed open");

  const itemlessTemplate = identityContext("nightshift-template", "", "status");
  const templateStatus = await checkNightshiftFactoryIdentity({
    ...itemlessTemplate,
    unresolvedMethodArgs: {},
  });
  if (templateStatus.pass) throw new Error("template accepted itemless status");

  for (const method of workItemMethods) {
    const template = await checkNightshiftFactoryIdentity(
      identityContext("nightshift-template", "132", method),
    );
    if (template.pass) throw new Error(`template accepted ${method}`);

    const mismatch = await checkNightshiftFactoryIdentity(
      identityContext("nightshift-run-132", "133", method),
    );
    if (mismatch.pass) throw new Error(`runtime mismatch accepted ${method}`);
  }

  const matching = await checkNightshiftFactoryIdentity(
    identityContext("nightshift-run-132", "132", "status"),
  );
  if (!matching.pass) throw new Error(matching.errors?.join("\n"));

  const duplicate = await checkNightshiftFactoryIdentity(
    identityContext("nightshift-run-132", "132", "start", "active", true),
  );
  if (duplicate.pass || !duplicate.errors?.[0].includes("another factory")) {
    throw new Error("cross-instance duplicate ownership was accepted");
  }
});

Deno.test("legacy factory freezes intake while preserving history and active drain", async () => {
  const start = await checkNightshiftFactoryIdentity(
    identityContext("the-nightshift", "132", "start"),
  );
  if (start.pass) throw new Error("legacy intake remained open");

  const beforeCutover = await checkNightshiftFactoryIdentity(
    identityContext("the-nightshift", "132", "start"),
    false,
  );
  if (!beforeCutover.pass)
    throw new Error("legacy intake froze before cutover");

  for (const method of ["status", "summary"]) {
    const history = await checkNightshiftFactoryIdentity(
      identityContext("the-nightshift", "23", method, "terminal"),
    );
    if (!history.pass) throw new Error(history.errors?.join("\n"));
  }

  const active = await checkNightshiftFactoryIdentity(
    identityContext("the-nightshift", "77", "record_artifact"),
  );
  if (!active.pass) throw new Error(active.errors?.join("\n"));

  const terminal = await checkNightshiftFactoryIdentity(
    identityContext("the-nightshift", "23", "advance", "terminal"),
  );
  if (terminal.pass) throw new Error("terminal legacy history was mutated");
});
