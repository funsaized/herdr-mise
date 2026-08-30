/** Correlates workflow-stage advances with their exact recorded run IDs. */
import { z } from "npm:zod@4.4.3";

const Outcome = z.object({
  status: z.enum(["succeeded", "failed"]),
  runId: z.string().min(1),
});
const Envelope = z.object({
  stageId: z.string(),
  cycle: z.number().int().positive(),
  payload: Outcome,
});
const State = z.object({
  stageId: z.string(),
  cycles: z.record(z.string(), z.number().int().positive()),
  enteredAt: z.string(),
});
const Factory = z.object({
  stages: z.array(
    z.object({
      id: z.string(),
      work: z
        .object({
          mode: z.string(),
          workflow: z.object({ name: z.string() }).passthrough().optional(),
          resultEvidence: z.string().optional(),
        })
        .passthrough()
        .optional(),
      transitions: z
        .array(
          z.object({
            name: z.string(),
            gates: z
              .array(
                z.object({
                  type: z.string(),
                  config: z.record(z.string(), z.unknown()),
                }),
              )
              .default([]),
          }),
        )
        .default([]),
    }),
  ),
});
const WorkflowSummary = z.object({
  status: z.string(),
  workflowName: z.string(),
  workflowRunId: z.string(),
});

type StoredData = {
  name: string;
  version?: number;
  ownerRef?: string;
  content?: unknown;
  createdAt?: string;
};
type Context = {
  globalArgs: Record<string, unknown>;
  modelType: string;
  modelId: string;
  definition?: { name: string };
  unresolvedMethodArgs?: Record<string, unknown>;
  definitionRepository?: {
    findById: (
      type: string,
      id: string,
    ) => Promise<{ globalArguments: Record<string, unknown> } | null>;
  };
  dataRepository: {
    findAllForModel: (type: string, modelId: string) => Promise<StoredData[]>;
    getContent: (
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  queryData?: (predicate: string) => Promise<unknown[]>;
  dataQueryService?: { query: (predicate: string) => Promise<unknown[]> };
};
type CheckResult = { pass: boolean; errors?: string[] };

function workItemSlug(workItem: string) {
  const sanitized = workItem
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48);
  if (sanitized === workItem) return workItem;
  let hash = 0x811c9dc5;
  for (let i = 0; i < workItem.length; i++) {
    hash ^= workItem.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return sanitized
    ? `${sanitized}-${hash.toString(16).padStart(8, "0")}`
    : hash.toString(16).padStart(8, "0");
}

async function latestJson(
  context: Context,
  name: string,
): Promise<unknown | null> {
  const records = (
    await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    )
  ).filter((record) => record.name === name);
  const latest = records.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
  if (!latest) return null;
  const bytes = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    latest.name,
    latest.version,
  );
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
}

async function summaryFrom(context: Context, record: StoredData) {
  if (typeof record.content === "string") {
    return WorkflowSummary.parse(JSON.parse(record.content));
  }
  if (record.content !== undefined) {
    return WorkflowSummary.parse(record.content);
  }
  if (!record.ownerRef)
    throw new Error("workflow summary has no owner reference");
  const bytes = await context.dataRepository.getContent(
    "workflow",
    record.ownerRef,
    "report-swamp-workflow-summary-json",
    record.version,
  );
  if (!bytes) throw new Error("workflow summary content is unavailable");
  return WorkflowSummary.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

function fail(message: string): CheckResult {
  return { pass: false, errors: [message] };
}

export async function checkCorrelatedWorkflowRun(
  context: Context,
): Promise<CheckResult> {
  const workItem = context.unresolvedMethodArgs?.workItem;
  const transitionName = context.unresolvedMethodArgs?.transition;
  if (typeof workItem !== "string" || typeof transitionName !== "string") {
    return { pass: true };
  }

  const definition = context.definitionRepository
    ? await context.definitionRepository.findById(
        context.modelType,
        context.modelId,
      )
    : null;
  const factory = Factory.safeParse(
    definition?.globalArguments ?? context.globalArgs,
  );
  if (!factory.success) {
    return fail(
      `cannot inspect factory workflow correlation: ${factory.error.message}`,
    );
  }
  const slug = workItemSlug(workItem);
  const state = State.safeParse(await latestJson(context, `state-${slug}`));
  if (!state.success) return { pass: true };
  const stage = factory.data.stages.find(
    (item) => item.id === state.data.stageId,
  );
  const transition = stage?.transitions.find(
    (item) => item.name === transitionName,
  );
  const resultEvidence = stage?.work?.resultEvidence;
  const workflow = stage?.work?.workflow?.name;
  if (!transition || !resultEvidence || !workflow) return { pass: true };

  const correlationGate = transition.gates.find(
    (gate) =>
      gate.type === "evidence-recorded" &&
      gate.config.name === resultEvidence &&
      (gate.config.requireField as Record<string, unknown> | undefined)
        ?.status === "succeeded",
  );
  if (!correlationGate) return { pass: true };

  const evidence = Envelope.safeParse(
    await latestJson(context, `evidence-${slug}-${resultEvidence}`),
  );
  const cycle = state.data.cycles[state.data.stageId];
  if (
    !evidence.success ||
    evidence.data.stageId !== state.data.stageId ||
    evidence.data.cycle !== cycle ||
    evidence.data.payload.status !== "succeeded"
  ) {
    return fail(
      `workflow result evidence '${resultEvidence}' is missing for the current ${state.data.stageId} cycle`,
    );
  }

  const query =
    context.queryData ??
    context.dataQueryService?.query.bind(context.dataQueryService);
  if (!query) return fail("workflow run records are unavailable");
  const runId = evidence.data.payload.runId;
  let records: StoredData[];
  try {
    records = (await query(
      'name == "report-swamp-workflow-summary-json" && modelType == "workflow"',
    )) as StoredData[];
  } catch (error) {
    return fail(
      `workflow run query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const matches = [];
  for (const record of records) {
    try {
      const summary = await summaryFrom(context, record);
      if (
        summary.workflowRunId === runId &&
        summary.workflowName === workflow
      ) {
        matches.push({ record, summary });
      }
    } catch {
      continue;
    }
  }
  if (matches.length !== 1) {
    return fail(
      `expected one run record for workflow '${workflow}' and runId '${runId}', found ${matches.length}`,
    );
  }
  const [{ record, summary }] = matches;
  if (summary.status !== "succeeded") {
    return fail(
      `workflow '${workflow}' runId '${runId}' has status '${summary.status}'`,
    );
  }
  if (
    record.createdAt &&
    Date.parse(record.createdAt) < Date.parse(state.data.enteredAt)
  ) {
    return fail(
      `workflow '${workflow}' runId '${runId}' predates the current stage cycle`,
    );
  }

  for (const gate of transition.gates) {
    if (!["artifact-exists", "artifact-fresh"].includes(gate.type)) continue;
    const artifact = gate.config.artifact;
    if (typeof artifact !== "string") continue;
    const outputs = await query(
      `workflowRunId == ${JSON.stringify(runId)} && name == ${JSON.stringify(`artifact-${slug}-${artifact}`)} && modelName == ${JSON.stringify(context.definition?.name ?? "")}`,
    );
    if (outputs.length === 0) {
      return fail(
        `verified run '${runId}' did not write artifact '${artifact}' for work item '${workItem}'`,
      );
    }
  }
  return { pass: true };
}

export const extension = {
  type: "@swamp/software-factory",
  methods: [],
  checks: [
    {
      "workflow-result-correlated": {
        description:
          "Workflow transitions require the exact successful run recorded in current-cycle result evidence",
        labels: ["policy"],
        appliesTo: ["advance"],
        execute: checkCorrelatedWorkflowRun,
      },
    },
  ],
};
