import {
  analyzeNightshift,
  attributeInvocationRounds,
  dedupeReviewRounds,
  loadFactoryInput,
  renderMarkdown,
  scopeInput,
  type AnalyticsInput,
  type Invocation,
  type ReportContext,
  type ReviewRound,
  type SourcePointer,
} from "../reports/nightshift_review_analytics.ts";

function source(
  plane: SourcePointer["plane"],
  dataName: string,
  workflowRunId?: string,
): SourcePointer {
  return {
    plane,
    modelName: plane === "factory" ? "the-nightshift" : "nightshift-reviewer",
    modelId: plane,
    dataName,
    version: 1,
    workflowRunId,
  };
}

type StoredRecord = {
  type: string;
  modelId: string;
  modelName: string;
  specName?: string;
  name: string;
  version: number;
  workflowRunId?: string;
  content: Record<string, unknown>;
};

function dataLike(record: StoredRecord): {
  name: string;
  version: number;
  tags: Record<string, string>;
} {
  const tags: Record<string, string> = { modelName: record.modelName };
  if (record.specName !== undefined) tags.specName = record.specName;
  if (record.workflowRunId !== undefined) {
    tags.workflowRunId = record.workflowRunId;
  }
  return { name: record.name, version: record.version, tags };
}

function makeRepository(
  records: StoredRecord[],
): ReportContext["dataRepository"] {
  const byName = new Map<string, StoredRecord[]>();
  for (const record of records) {
    const key = `${record.type}|${record.modelId}|${record.name}`;
    const list = byName.get(key) ?? [];
    list.push(record);
    byName.set(key, list);
  }
  const lookup = (type: string, modelId: string, name: string) =>
    byName.get(`${type}|${modelId}|${name}`) ?? [];
  return {
    async findAllForModel(_type, modelId) {
      return records
        .filter((record) => record.modelId === modelId)
        .map(dataLike);
    },
    async findAllForType(type) {
      return records
        .filter((record) => record.type === String(type))
        .map((record) => ({ data: dataLike(record), modelId: record.modelId }));
    },
    async findByName(_type, modelId, name, version) {
      const list = lookup(String(_type), modelId, name).filter(
        (record) => version === undefined || record.version === version,
      );
      const record = list.at(-1);
      return record ? dataLike(record) : null;
    },
    async listVersions(_type, modelId, name) {
      return lookup(String(_type), modelId, name)
        .map((record) => record.version)
        .sort((a, b) => a - b);
    },
    async getContent(_type, modelId, name, version) {
      const list = lookup(String(_type), modelId, name).filter(
        (record) => version === undefined || record.version === version,
      );
      const record = list.at(-1);
      return record
        ? new TextEncoder().encode(JSON.stringify(record.content))
        : null;
    },
  };
}

function reportContext(
  repository: ReportContext["dataRepository"],
): ReportContext {
  return {
    modelType: "@swamp/software-factory",
    modelId: "report-host-id",
    methodName: "summary",
    methodArgs: {},
    executionStatus: "succeeded",
    dataRepository: repository,
  };
}

function stateRecord(options: {
  modelId: string;
  modelName: string;
  workItem: string;
  stageId: string;
}): StoredRecord {
  return {
    type: "@swamp/software-factory",
    modelId: options.modelId,
    modelName: options.modelName,
    name: `state-${options.workItem}`,
    version: 1,
    content: {
      workItem: options.workItem,
      stageId: options.stageId,
      startedAt: "2026-08-01T00:00:00Z",
    },
  };
}

function reviewRecord(options: {
  modelId: string;
  modelName: string;
  workItem: string;
  verdict: "pass" | "fail";
}): StoredRecord {
  return {
    type: "@swamp/software-factory",
    modelId: options.modelId,
    modelName: options.modelName,
    name: `artifact-${options.workItem}-code-review`,
    version: 1,
    content: {
      workItem: options.workItem,
      stageId: "code-review",
      cycle: 1,
      payload: { findings: [{ category: `round:${options.verdict}` }] },
      recordedAt: "2026-08-01T00:00:00Z",
    },
  };
}

function invocationRecord(options: {
  modelId: string;
  name: string;
  workItem: string;
  modelNameTag?: string;
}): StoredRecord {
  const tags: Record<string, string> = {
    factory: "nightshift",
    workItem: options.workItem,
  };
  if (options.modelNameTag !== undefined) {
    tags.modelName = options.modelNameTag;
  }
  return {
    type: "@funsaized/cli-agent",
    modelId: options.modelId,
    modelName: "nightshift-reviewer",
    specName: "invocation",
    name: options.name,
    version: 1,
    content: {
      tags,
      provider: "opencode",
      model: "openai/test",
      success: true,
    },
  };
}

Deno.test("analytics joins review rounds without treating zero cost as free", () => {
  const input: AnalyticsInput = {
    factoryItems: [
      {
        workItem: "1",
        outcome: "parked",
        startedAt: "2026-08-01T00:00:00Z",
        source: source("factory", "state-1"),
      },
      {
        workItem: "2",
        outcome: "in-flight",
        startedAt: "2026-08-02T00:00:00Z",
        source: source("factory", "state-2"),
      },
    ],
    reviewRounds: [
      {
        workItem: "1",
        phase: "code",
        round: 1,
        verdict: "fail",
        laneVerdicts: { "clean-code": "pass" },
        workflowRunId: "review-1",
        source: source("factory", "artifact-1-code-review", "review-1"),
      },
      {
        workItem: "1",
        phase: "code",
        round: 2,
        verdict: "warn",
        laneVerdicts: { "clean-code": "warn" },
        workflowRunId: "review-2",
        source: {
          ...source("factory", "artifact-1-code-review", "review-2"),
          version: 2,
        },
      },
    ],
    invocations: [
      {
        workItem: "1",
        provider: "opencode",
        model: "openai/test",
        role: "reviewer",
        stage: "code-review",
        phase: "code",
        round: 1,
        lane: "clean-code",
        workflowRunId: "review-1",
        success: true,
        durationMs: 10,
        retries: 0,
        tokens: { input: 100, output: 20, cacheRead: 50, total: 120 },
        providerReportedCostUsd: 0,
        source: source("cli-agent", "invocation-1", "review-1"),
      },
      {
        workItem: "1",
        provider: "opencode",
        model: "openai/test",
        role: "reviewer",
        stage: "code-review",
        phase: "code",
        round: 2,
        lane: "clean-code",
        workflowRunId: "review-2",
        success: true,
        durationMs: 20,
        retries: 1,
        tokens: { input: 80, output: 10, cacheRead: 40, total: 90 },
        providerReportedCostUsd: 0.25,
        source: source("cli-agent", "invocation-2", "review-2"),
      },
    ],
    failureWorkflowKinds: {},
    evidenceSources: [],
    journalSources: [source("factory", "journal-1")],
    malformedWorkItems: [],
    unmeteredInteractiveWorkCount: 1,
  };

  const result = analyzeNightshift(input);
  if (result.usage.total.tokens.total.value !== 210) {
    throw new Error("provider total was changed by cache token fields");
  }
  if (
    result.usage.total.zeroCostInvocationCount !== 1 ||
    result.usage.total.nonzeroCostInvocationCount !== 1 ||
    result.usage.total.providerReportedCostUsd.value !== 0.25
  ) {
    throw new Error("provider-reported cost coverage is incorrect");
  }
  if (
    result.reviewEffectiveness.kaplanMeier.all[1]?.mergeable
      .conditionalProbability !== 1
  ) {
    throw new Error("conditional mergeability did not use the at-risk cohort");
  }
  if (
    result.reviewEffectiveness.findingsAfterPreviouslyCleanLane.length !== 1
  ) {
    throw new Error("a lane regression after a clean round was not recorded");
  }
  if (result.coverage.unmeteredDriverWorkCount.value !== null) {
    throw new Error("unmetered driver work was reported as zero");
  }
  const unassessed = result.reviewEffectiveness.firstMergeable.filter(
    (item) => item.workItem === "2" && item.censored,
  );
  if (unassessed.length !== 2) {
    throw new Error(
      "unassessed plan and code phases were omitted from censoring",
    );
  }
  if (
    result.usage.byCohort.mergeable.invocationCount !== 2 ||
    result.usage.byCohort["never-clean-pass"].invocationCount !== 2 ||
    result.usage.byCohort.censored.invocationCount !== 0
  ) {
    throw new Error("overlapping and censored cohorts are incorrect");
  }
});

Deno.test("review cycles deduplicate and planner/build usage inherits the next round", () => {
  const reviewed: ReviewRound = {
    workItem: "7",
    phase: "code",
    round: 1,
    verdict: "warn",
    laneVerdicts: { "clean-code": "warn" },
    recordedAt: "2026-08-01T00:02:00Z",
    workflowRunId: "review-7",
    source: source("factory", "artifact-7-code-review", "review-7"),
  };
  const resolved: ReviewRound = {
    ...reviewed,
    workflowRunId: undefined,
    source: {
      ...source("factory", "artifact-7-code-review"),
      version: 2,
    },
  };
  const rounds = dedupeReviewRounds([resolved, reviewed]);
  if (rounds.length !== 1 || rounds[0].workflowRunId !== "review-7") {
    throw new Error("a findings update was counted as another review round");
  }
  const rerun: ReviewRound = {
    ...reviewed,
    verdict: "pass",
    workflowRunId: "review-7-new",
    recordedAt: "2026-08-01T00:03:00Z",
    source: source("factory", "artifact-7-code-review", "review-7-new"),
  };
  const [latest] = dedupeReviewRounds([reviewed, rerun]);
  if (latest.workflowRunId !== "review-7-new" || latest.verdict !== "pass") {
    throw new Error("a newer rerun did not replace the stale review cycle");
  }

  const builder: Invocation = {
    workItem: "7",
    provider: "opencode",
    model: "openai/test",
    role: "builder",
    stage: "build",
    success: true,
    tokens: { total: 10 },
    invokedAt: "2026-08-01T00:01:00Z",
    source: source("cli-agent", "invocation-build-7"),
  };
  const [attributed] = attributeInvocationRounds([builder], rounds);
  if (attributed.phase !== "code" || attributed.round !== 1) {
    throw new Error(
      "builder usage was omitted from the review round it produced",
    );
  }
});

Deno.test("mergeability elbow is the last useful round", () => {
  const input: AnalyticsInput = {
    factoryItems: [
      {
        workItem: "1",
        outcome: "done",
        source: source("factory", "state-1"),
      },
      {
        workItem: "2",
        outcome: "aborted",
        source: source("factory", "state-2"),
      },
    ],
    reviewRounds: [
      {
        workItem: "1",
        phase: "plan",
        round: 1,
        verdict: "warn",
        laneVerdicts: { "clean-code": "warn" },
        source: source("factory", "artifact-1-plan-review"),
      },
      {
        workItem: "2",
        phase: "plan",
        round: 1,
        verdict: "fail",
        laneVerdicts: { "clean-code": "fail" },
        source: source("factory", "artifact-2-plan-review"),
      },
      {
        workItem: "2",
        phase: "plan",
        round: 2,
        verdict: "fail",
        laneVerdicts: { "clean-code": "fail" },
        source: {
          ...source("factory", "artifact-2-plan-review"),
          version: 2,
        },
      },
    ],
    invocations: [],
    failureWorkflowKinds: {},
    evidenceSources: [],
    journalSources: [],
    malformedWorkItems: [],
    unmeteredInteractiveWorkCount: 0,
  };

  const elbow =
    analyzeNightshift(input).reviewEffectiveness.marginalMergeabilityElbow;
  if (elbow.value !== 1) {
    throw new Error(
      "elbow reported the first wasted round, not the last useful round",
    );
  }
});

Deno.test("an unresolved in-flight phase suppresses the mergeability elbow", () => {
  const input: AnalyticsInput = {
    factoryItems: [
      {
        workItem: "1",
        outcome: "done",
        source: source("factory", "state-1"),
      },
      {
        workItem: "2",
        outcome: "in-flight",
        source: source("factory", "state-2"),
      },
    ],
    reviewRounds: [
      {
        workItem: "1",
        phase: "plan",
        round: 1,
        verdict: "warn",
        laneVerdicts: {},
        source: source("factory", "artifact-1-plan-review"),
      },
      {
        workItem: "2",
        phase: "plan",
        round: 1,
        verdict: "fail",
        laneVerdicts: {},
        source: source("factory", "artifact-2-plan-review"),
      },
      {
        workItem: "2",
        phase: "plan",
        round: 2,
        verdict: "fail",
        laneVerdicts: {},
        source: {
          ...source("factory", "artifact-2-plan-review"),
          version: 2,
        },
      },
    ],
    invocations: [],
    failureWorkflowKinds: {},
    evidenceSources: [],
    journalSources: [],
    malformedWorkItems: [],
    unmeteredInteractiveWorkCount: 0,
  };

  if (
    analyzeNightshift(input).reviewEffectiveness.marginalMergeabilityElbow
      .value !== null
  ) {
    throw new Error("in-flight work was treated as a resolved zero-gain tail");
  }
});

Deno.test("partial item usage and unknown success remain explicit", () => {
  const input: AnalyticsInput = {
    factoryItems: [
      {
        workItem: "1",
        outcome: "done",
        source: source("factory", "state-1"),
      },
      {
        workItem: "2",
        outcome: "done",
        source: source("factory", "state-2"),
      },
    ],
    reviewRounds: [],
    invocations: [
      {
        workItem: "1",
        provider: "opencode",
        model: "openai/test",
        role: "builder",
        stage: "build",
        success: true,
        tokens: { total: 10 },
        providerReportedCostUsd: 1,
        source: source("cli-agent", "invocation-1"),
      },
      {
        workItem: "2",
        provider: "opencode",
        model: "openai/test",
        role: "builder",
        stage: "build",
        tokens: {},
        source: source("cli-agent", "invocation-2"),
      },
      {
        workItem: "#106",
        provider: "opencode",
        model: "openai/test",
        role: "builder",
        stage: "build",
        success: false,
        tokens: { total: 999 },
        providerReportedCostUsd: 999,
        source: source("cli-agent", "invocation-malformed"),
      },
    ],
    failureWorkflowKinds: {},
    evidenceSources: [],
    journalSources: [],
    malformedWorkItems: [],
    unmeteredInteractiveWorkCount: 0,
  };

  const result = analyzeNightshift(input);
  const tokens = result.efficiency.delivered.tokensPerDeliveredWorkItem;
  if (
    tokens.value !== 10 ||
    tokens.availability !== "partial" ||
    tokens.covered !== 1 ||
    tokens.total !== 2
  ) {
    throw new Error("missing per-item usage was averaged as zero");
  }
  if (
    result.coverage.successRate.value !== 1 ||
    result.coverage.successRate.availability !== "partial" ||
    result.efficiency.failedInvocations.invocationCount !== 0 ||
    result.coverage.invocationCount !== 2
  ) {
    throw new Error("unknown or malformed invocation data was misclassified");
  }
  const markdown = renderMarkdown(result);
  if (
    !markdown.includes("P(mergeable this round \\| not yet)") ||
    !markdown.includes("Unmetered interactive | Driver usage")
  ) {
    throw new Error("markdown omitted required table escaping or disclosures");
  }
});

Deno.test("item scope retains evidence-only failures", () => {
  const input: AnalyticsInput = {
    factoryItems: [
      {
        workItem: "1",
        outcome: "done",
        source: source("factory", "state-1"),
      },
      {
        workItem: "2",
        outcome: "done",
        source: source("factory", "state-2"),
      },
    ],
    reviewRounds: [],
    invocations: [],
    failureWorkflowKinds: {
      "run-1": { kind: "configuration", workItem: "1" },
      "run-2": { kind: "infrastructure", workItem: "2" },
    },
    evidenceSources: [
      source("factory", "evidence-1-build-run"),
      source("factory", "evidence-2-build-run"),
    ],
    journalSources: [],
    malformedWorkItems: [],
    unmeteredInteractiveWorkCount: 0,
  };

  const scoped = analyzeNightshift(scopeInput(input, "1"));
  if (
    scoped.reviewEffectiveness.configurationFailureCount !== 1 ||
    scoped.reviewEffectiveness.infrastructureFailureCount !== 0 ||
    scoped.coverage.factoryWorkItemCount !== 1
  ) {
    throw new Error("item scope dropped or leaked evidence-only failures");
  }
});

Deno.test("loadFactoryInput includes legacy and runtime factories with correct pointers", async () => {
  const input = await loadFactoryInput(
    reportContext(
      makeRepository([
        stateRecord({
          modelId: "legacy-id",
          modelName: "the-nightshift",
          workItem: "1",
          stageId: "done",
        }),
        stateRecord({
          modelId: "runtime-id",
          modelName: "nightshift-run-2",
          workItem: "2",
          stageId: "building",
        }),
        stateRecord({
          modelId: "other-id",
          modelName: "other-factory",
          workItem: "99",
          stageId: "building",
        }),
      ]),
    ),
  );
  const workItems = input.factoryItems
    .map((item) => item.workItem)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (workItems.join(",") !== "1,2") {
    throw new Error(
      `expected legacy and runtime factories only, got ${workItems.join(",")}`,
    );
  }
  const legacy = input.factoryItems.find((item) => item.workItem === "1")!;
  if (
    legacy.source.modelId !== "legacy-id" ||
    legacy.source.modelName !== "the-nightshift" ||
    legacy.outcome !== "done"
  ) {
    throw new Error("terminal legacy pointer or outcome is incorrect");
  }
  const runtime = input.factoryItems.find((item) => item.workItem === "2")!;
  if (
    runtime.source.modelId !== "runtime-id" ||
    runtime.source.modelName !== "nightshift-run-2"
  ) {
    throw new Error("runtime pointer is incorrect");
  }
});

Deno.test("loadFactoryInput rejects nightshift-template data", async () => {
  const repository = makeRepository([
    stateRecord({
      modelId: "template-id",
      modelName: "nightshift-template",
      workItem: "1",
      stageId: "building",
    }),
  ]);
  let message = "";
  try {
    await loadFactoryInput(reportContext(repository));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("nightshift-template")) {
    throw new Error("template factory data did not throw an invariant error");
  }
});

Deno.test("loadFactoryInput isolates review rounds to the owning factory model", async () => {
  const input = await loadFactoryInput(
    reportContext(
      makeRepository([
        stateRecord({
          modelId: "legacy-id",
          modelName: "the-nightshift",
          workItem: "7",
          stageId: "building",
        }),
        reviewRecord({
          modelId: "legacy-id",
          modelName: "the-nightshift",
          workItem: "7",
          verdict: "pass",
        }),
        stateRecord({
          modelId: "runtime-8-id",
          modelName: "nightshift-run-8",
          workItem: "8",
          stageId: "building",
        }),
        reviewRecord({
          modelId: "runtime-8-id",
          modelName: "nightshift-run-8",
          workItem: "7",
          verdict: "fail",
        }),
      ]),
    ),
  );
  if (
    input.reviewRounds.length !== 1 ||
    input.reviewRounds[0].source.modelId !== "legacy-id"
  ) {
    throw new Error(
      `expected only the legacy review round, got ${input.reviewRounds.length}`,
    );
  }
});

Deno.test("dedupeReviewRounds keeps duplicate work items separate across model IDs", async () => {
  const input = await loadFactoryInput(
    reportContext(
      makeRepository([
        stateRecord({
          modelId: "legacy-id",
          modelName: "the-nightshift",
          workItem: "7",
          stageId: "building",
        }),
        reviewRecord({
          modelId: "legacy-id",
          modelName: "the-nightshift",
          workItem: "7",
          verdict: "pass",
        }),
        stateRecord({
          modelId: "runtime-7-id",
          modelName: "nightshift-run-7",
          workItem: "7",
          stageId: "building",
        }),
        reviewRecord({
          modelId: "runtime-7-id",
          modelName: "nightshift-run-7",
          workItem: "7",
          verdict: "fail",
        }),
      ]),
    ),
  );
  if (input.reviewRounds.length !== 2) {
    throw new Error(
      `expected two distinct review rounds across models, got ${input.reviewRounds.length}`,
    );
  }
  let message = "";
  try {
    analyzeNightshift(input);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("multiple factory owners")) {
    throw new Error(
      "split factory ownership did not make analytics unavailable",
    );
  }
});

Deno.test("cli-agent invocations resolve the factory by modelName tag and reject ambiguity", async () => {
  const input = await loadFactoryInput(
    reportContext(
      makeRepository([
        stateRecord({
          modelId: "legacy-id",
          modelName: "the-nightshift",
          workItem: "7",
          stageId: "building",
        }),
        stateRecord({
          modelId: "runtime-7-id",
          modelName: "nightshift-run-7",
          workItem: "7",
          stageId: "building",
        }),
        invocationRecord({
          modelId: "cli-a",
          name: "invocation-a",
          workItem: "7",
          modelNameTag: "the-nightshift",
        }),
        invocationRecord({
          modelId: "cli-b",
          name: "invocation-b",
          workItem: "7",
        }),
      ]),
    ),
  );
  const names = input.invocations
    .map((invocation) => invocation.source.dataName)
    .sort();
  if (names.join(",") !== "invocation-a") {
    throw new Error(
      `expected only the tagged invocation, got ${names.join(",")}`,
    );
  }
});
