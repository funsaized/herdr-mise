import {
  analyzeNightshift,
  attributeInvocationRounds,
  dedupeReviewRounds,
  renderMarkdown,
  scopeInput,
  type AnalyticsInput,
  type Invocation,
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
