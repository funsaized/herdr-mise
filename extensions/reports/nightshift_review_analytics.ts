/** Deterministic review, token, and provider-reported cost analytics for Nightshift. */

const FACTORY_TYPE = "@swamp/software-factory";
const CLI_AGENT_TYPES = ["@mgreten/cli-agent", "@funsaized/cli-agent"];
const RUNTIME_FACTORY_NAME = /^nightshift-run-[1-9][0-9]*$/;
const LANES = [
  "accessibility",
  "clean-code",
  "ddd",
  "frontend",
  "observability",
  "security",
  "test-coverage",
] as const;
const TOKEN_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "total",
] as const;

type ReviewPhase = "plan" | "code";
type Verdict = "pass" | "warn" | "fail";
type Outcome = "done" | "aborted" | "parked" | "in-flight";
type TokenField = (typeof TOKEN_FIELDS)[number];

export interface SourcePointer {
  plane: "factory" | "cli-agent";
  modelName: string;
  modelId: string;
  dataName: string;
  version: number;
  workflowRunId?: string;
}

export interface ReviewRound {
  workItem: string;
  phase: ReviewPhase;
  round: number;
  verdict: Verdict;
  laneVerdicts: Partial<Record<(typeof LANES)[number], Verdict>>;
  recordedAt?: string;
  workflowRunId?: string;
  source: SourcePointer;
}

export interface FactoryItem {
  workItem: string;
  outcome: Outcome;
  startedAt?: string;
  source: SourcePointer;
}

export interface Invocation {
  workItem: string;
  provider: string;
  model: string;
  role: "planner" | "builder" | "reviewer" | "driver" | "unknown";
  stage: string;
  phase?: ReviewPhase;
  round?: number;
  lane?: string;
  workflowRunId?: string;
  success?: boolean;
  durationMs?: number;
  retries?: number;
  failureClass?: string;
  tokens: Partial<Record<TokenField, number>>;
  providerReportedCostUsd?: number;
  invokedAt?: string;
  source: SourcePointer;
}

export interface AnalyticsInput {
  factoryItems: FactoryItem[];
  reviewRounds: ReviewRound[];
  invocations: Invocation[];
  failureWorkflowKinds: Record<string, { kind: string; workItem: string }>;
  evidenceSources: SourcePointer[];
  journalSources: SourcePointer[];
  malformedWorkItems: string[];
  unmeteredInteractiveWorkCount: number;
}

interface DataLike {
  name: string;
  version: number;
  tags: Record<string, string>;
  createdAt?: Date | string;
}

interface DataRepositoryLike {
  findAllForModel(type: unknown, modelId: string): Promise<DataLike[]>;
  findAllForType(
    type: unknown,
  ): Promise<Array<{ data: DataLike; modelId: string }>>;
  findByName(
    type: unknown,
    modelId: string,
    name: string,
    version?: number,
  ): Promise<DataLike | null>;
  listVersions(type: unknown, modelId: string, name: string): Promise<number[]>;
  getContent(
    type: unknown,
    modelId: string,
    name: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

export interface ReportContext {
  modelType: unknown;
  modelId: string;
  methodName: string;
  methodArgs: Record<string, unknown>;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  definition?: { name?: string };
  dataRepository: DataRepositoryLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isCanonicalWorkItem(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

function dateValue(value: Date | string | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return stringValue(value);
}

function pointer(
  plane: SourcePointer["plane"],
  modelId: string,
  data: DataLike,
): SourcePointer {
  return {
    plane,
    modelName: data.tags.modelName ?? "unknown",
    modelId,
    dataName: data.name,
    version: data.version,
    ...(data.tags.workflowRunId
      ? { workflowRunId: data.tags.workflowRunId }
      : {}),
  };
}

async function readJson(
  repository: DataRepositoryLike,
  type: unknown,
  modelId: string,
  name: string,
  version?: number,
): Promise<Record<string, unknown> | null> {
  const bytes = await repository.getContent(type, modelId, name, version);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readVersions(
  repository: DataRepositoryLike,
  type: unknown,
  modelId: string,
  name: string,
): Promise<Array<{ data: DataLike; content: Record<string, unknown> }>> {
  const records = [];
  for (const version of await repository.listVersions(type, modelId, name)) {
    const [data, content] = await Promise.all([
      repository.findByName(type, modelId, name, version),
      readJson(repository, type, modelId, name, version),
    ]);
    if (data !== null && content !== null) records.push({ data, content });
  }
  return records;
}

function reviewVerdict(value: unknown): Verdict | undefined {
  return value === "pass" || value === "warn" || value === "fail"
    ? value
    : undefined;
}

function parseReviewRound(
  content: Record<string, unknown>,
  source: SourcePointer,
): ReviewRound | null {
  const workItem = stringValue(content.workItem);
  const stageId = stringValue(content.stageId);
  const round = numberValue(content.cycle);
  const payload = isRecord(content.payload) ? content.payload : null;
  const findings = Array.isArray(payload?.findings) ? payload.findings : [];
  if (
    workItem === undefined ||
    round === undefined ||
    !Number.isInteger(round) ||
    round <= 0 ||
    (stageId !== "plan-review" && stageId !== "code-review")
  ) {
    return null;
  }

  let verdict: Verdict | undefined;
  const laneVerdicts: ReviewRound["laneVerdicts"] = {};
  const rank = { pass: 1, warn: 2, fail: 3 } as const;
  for (const raw of findings) {
    if (!isRecord(raw)) continue;
    const category = stringValue(raw.category);
    if (category === undefined) continue;
    const separator = category.lastIndexOf(":");
    if (separator < 1) continue;
    const name = category.slice(0, separator);
    const findingVerdict = reviewVerdict(category.slice(separator + 1));
    if (findingVerdict === undefined) continue;
    if (name === "round") {
      verdict = findingVerdict;
      continue;
    }
    if (!LANES.includes(name as (typeof LANES)[number])) continue;
    const lane = name as (typeof LANES)[number];
    const current = laneVerdicts[lane];
    if (current === undefined || rank[findingVerdict] > rank[current]) {
      laneVerdicts[lane] = findingVerdict;
    }
  }
  if (verdict === undefined) return null;
  return {
    workItem,
    phase: stageId === "plan-review" ? "plan" : "code",
    round,
    verdict,
    laneVerdicts,
    recordedAt: stringValue(content.recordedAt),
    workflowRunId: source.workflowRunId,
    source,
  };
}

function parseOutcome(stageId: string | undefined): Outcome {
  if (stageId === "done") return "done";
  if (stageId === "aborted") return "aborted";
  if (stageId === "parked") return "parked";
  return "in-flight";
}

function isFactoryNameIncluded(modelName: string): boolean {
  return modelName === "the-nightshift" || RUNTIME_FACTORY_NAME.test(modelName);
}

function resolveFactoryModelId(
  factoryModelName: string | undefined,
  workItem: string,
  factoryWorkItems: Set<string>,
  factoryModelIdsByName: Map<string, string>,
  factoryModelIdsByWorkItem: Map<string, Set<string>>,
): string | undefined {
  if (factoryModelName !== undefined) {
    const modelId = factoryModelIdsByName.get(factoryModelName);
    return modelId !== undefined &&
      factoryWorkItems.has(`${modelId}:${workItem}`)
      ? modelId
      : undefined;
  }
  const owners = factoryModelIdsByWorkItem.get(workItem);
  return owners !== undefined && owners.size === 1 ? [...owners][0] : undefined;
}

export async function loadFactoryInput(
  context: ReportContext,
): Promise<AnalyticsInput> {
  const repository = context.dataRepository;
  const allFactoryResources = await repository.findAllForType(
    context.modelType,
  );
  for (const resource of allFactoryResources) {
    if (resource.data.tags.modelName === "nightshift-template") {
      throw new Error(
        `nightshift-template factory data must never be analyzed (model ${resource.modelId})`,
      );
    }
  }
  const resourcesByModel = groupBy(
    allFactoryResources.filter((resource) =>
      isFactoryNameIncluded(resource.data.tags.modelName ?? ""),
    ),
    (resource) => resource.modelId,
  );

  const factoryItems: FactoryItem[] = [];
  const malformedWorkItems = new Set<string>();
  const factoryWorkItems = new Set<string>(); // `${modelId}:${workItem}`
  const factoryModelIdsByName = new Map<string, string>();
  const factoryModelIdsByWorkItem = new Map<string, Set<string>>();
  const reviewRoundCandidates: ReviewRound[] = [];
  const failureWorkflowKinds: AnalyticsInput["failureWorkflowKinds"] = {};
  const evidenceSources: SourcePointer[] = [];
  let unmeteredInteractiveWorkCount = 0;
  const journalSources: SourcePointer[] = [];

  for (const [modelId, resources] of Object.entries(resourcesByModel)) {
    const modelName = resources[0]?.data.tags.modelName;
    if (modelName !== undefined) factoryModelIdsByName.set(modelName, modelId);
    const names = resources.map((resource) => resource.data.name);
    const stateNames = names.filter((name) => name.startsWith("state-")).sort();
    const reviewNames = names
      .filter((name) => /-(plan|code)-review$/.test(name))
      .sort();
    const evidenceNames = names
      .filter((name) => name.startsWith("evidence-"))
      .sort();
    const journalNames = names
      .filter((name) => name.startsWith("journal-"))
      .sort();

    for (const name of stateNames) {
      const data = resources.find(
        (candidate) => candidate.data.name === name,
      )?.data;
      const content = await readJson(
        repository,
        context.modelType,
        modelId,
        name,
      );
      if (data === undefined || content === null) continue;
      const workItem =
        stringValue(content.workItem) ?? name.slice("state-".length);
      if (!isCanonicalWorkItem(workItem)) {
        malformedWorkItems.add(workItem);
        continue;
      }
      factoryWorkItems.add(`${modelId}:${workItem}`);
      const owners = factoryModelIdsByWorkItem.get(workItem);
      if (owners === undefined) {
        factoryModelIdsByWorkItem.set(workItem, new Set([modelId]));
      } else {
        owners.add(modelId);
      }
      factoryItems.push({
        workItem,
        outcome: parseOutcome(stringValue(content.stageId)),
        startedAt: stringValue(content.startedAt),
        source: pointer("factory", modelId, data),
      });
    }

    for (const name of reviewNames) {
      for (const record of await readVersions(
        repository,
        context.modelType,
        modelId,
        name,
      )) {
        const workItem = stringValue(record.content.workItem);
        if (workItem !== undefined && !isCanonicalWorkItem(workItem)) {
          malformedWorkItems.add(workItem);
          continue;
        }
        const parsed = parseReviewRound(
          record.content,
          pointer("factory", modelId, record.data),
        );
        if (
          parsed === null ||
          !factoryWorkItems.has(`${modelId}:${parsed.workItem}`)
        ) {
          continue;
        }
        reviewRoundCandidates.push(parsed);
      }
    }

    for (const name of evidenceNames) {
      for (const record of await readVersions(
        repository,
        context.modelType,
        modelId,
        name,
      )) {
        const payload = isRecord(record.content.payload)
          ? record.content.payload
          : null;
        const outputs = isRecord(payload?.outputs) ? payload.outputs : null;
        const runId = stringValue(payload?.runId);
        const failureKind = stringValue(outputs?.failureKind);
        const workItem = stringValue(record.content.workItem);
        if (workItem !== undefined && !isCanonicalWorkItem(workItem)) {
          malformedWorkItems.add(workItem);
        }
        if (
          runId !== undefined &&
          failureKind !== undefined &&
          workItem !== undefined &&
          isCanonicalWorkItem(workItem) &&
          factoryWorkItems.has(`${modelId}:${workItem}`)
        ) {
          failureWorkflowKinds[runId] = { kind: failureKind, workItem };
          if (failureKind !== "none") {
            evidenceSources.push(pointer("factory", modelId, record.data));
          }
        }
      }
    }

    for (const name of journalNames) {
      const workItem = name.slice("journal-".length);
      if (!isCanonicalWorkItem(workItem)) {
        malformedWorkItems.add(workItem);
        continue;
      }
      if (!factoryWorkItems.has(`${modelId}:${workItem}`)) continue;
      for (const record of await readVersions(
        repository,
        context.modelType,
        modelId,
        name,
      )) {
        if (
          record.content.event === "dispatched" &&
          ["plan-feedback", "ship-prep"].includes(
            String(record.content.stageId),
          )
        ) {
          unmeteredInteractiveWorkCount += 1;
          journalSources.push(pointer("factory", modelId, record.data));
        }
      }
    }
  }
  const reviewRounds = dedupeReviewRounds(reviewRoundCandidates);

  const roundByWorkflow = new Map(
    reviewRounds
      .filter((round) => round.workflowRunId !== undefined)
      .map((round) => [round.workflowRunId!, round]),
  );
  const invocations: Invocation[] = [];
  const cliAgentResources = (
    await Promise.all(
      CLI_AGENT_TYPES.map(async (type) =>
        (await repository.findAllForType(type)).map((resource) => ({
          ...resource,
          type,
        })),
      ),
    )
  ).flat();
  for (const { data, modelId, type } of cliAgentResources) {
    if (data.tags.specName !== "invocation") continue;
    const content = await readJson(
      repository,
      type,
      modelId,
      data.name,
      data.version,
    );
    if (content === null) continue;
    const tags = isRecord(content.tags) ? content.tags : {};
    if (tags.factory !== "nightshift") continue;
    const workItem = stringValue(tags.workItem);
    if (workItem === undefined) continue;
    if (!isCanonicalWorkItem(workItem)) {
      malformedWorkItems.add(workItem);
      continue;
    }
    if (
      resolveFactoryModelId(
        stringValue(tags.modelName),
        workItem,
        factoryWorkItems,
        factoryModelIdsByName,
        factoryModelIdsByWorkItem,
      ) === undefined
    ) {
      continue;
    }
    const workflowRunId = data.tags.workflowRunId;
    const review = workflowRunId
      ? roundByWorkflow.get(workflowRunId)
      : undefined;
    const lane = stringValue(tags.lane);
    const stageTag = stringValue(tags.stage);
    const phaseTag =
      tags.phase === "plan" || tags.phase === "code" ? tags.phase : undefined;
    const tokens = isRecord(content.tokens) ? content.tokens : {};
    const parsedTokens: Partial<Record<TokenField, number>> = {};
    for (const field of TOKEN_FIELDS) {
      const value = numberValue(tokens[field]);
      if (value !== undefined) parsedTokens[field] = value;
    }
    const role =
      lane !== undefined
        ? "reviewer"
        : stageTag === "plan"
          ? "planner"
          : stageTag === "build"
            ? "builder"
            : stageTag === "driver"
              ? "driver"
              : "unknown";
    invocations.push({
      workItem,
      provider: stringValue(content.provider) ?? "unknown",
      model: stringValue(content.model) ?? "unknown",
      role,
      stage:
        lane !== undefined
          ? `${review?.phase ?? phaseTag ?? "unknown"}-review`
          : (stageTag ?? "unknown"),
      phase: review?.phase ?? phaseTag,
      round: review?.round,
      lane,
      workflowRunId,
      success:
        typeof content.success === "boolean" ? content.success : undefined,
      durationMs: numberValue(content.durationMs),
      retries: numberValue(content.retries),
      failureClass: stringValue(content.failureClass),
      tokens: parsedTokens,
      providerReportedCostUsd: numberValue(content.costUsd),
      invokedAt: stringValue(content.invokedAt) ?? dateValue(data.createdAt),
      source: pointer("cli-agent", modelId, data),
    });
  }

  const attributedInvocations = attributeInvocationRounds(
    invocations,
    reviewRounds,
  );

  return {
    factoryItems: factoryItems.sort((a, b) =>
      a.workItem.localeCompare(b.workItem, undefined, { numeric: true }),
    ),
    reviewRounds,
    invocations: attributedInvocations.sort(compareInvocations),
    failureWorkflowKinds,
    evidenceSources,
    journalSources,
    malformedWorkItems: [...malformedWorkItems].sort(),
    unmeteredInteractiveWorkCount,
  };
}

export function scopeInput(
  input: AnalyticsInput,
  workItem: string,
): AnalyticsInput {
  const invocations = input.invocations.filter(
    (invocation) => invocation.workItem === workItem,
  );
  const workflowRunIds = new Set(
    invocations
      .map((invocation) => invocation.workflowRunId)
      .filter((value): value is string => value !== undefined),
  );
  return {
    factoryItems: input.factoryItems.filter(
      (item) => item.workItem === workItem,
    ),
    reviewRounds: input.reviewRounds.filter(
      (round) => round.workItem === workItem,
    ),
    invocations,
    failureWorkflowKinds: Object.fromEntries(
      Object.entries(input.failureWorkflowKinds).filter(
        ([runId, failure]) =>
          failure.workItem === workItem || workflowRunIds.has(runId),
      ),
    ),
    evidenceSources: input.evidenceSources.filter((source) =>
      source.dataName.startsWith(`evidence-${workItem}-`),
    ),
    journalSources: input.journalSources.filter(
      (source) => source.dataName === `journal-${workItem}`,
    ),
    malformedWorkItems: input.malformedWorkItems.filter(
      (value) => value === workItem,
    ),
    unmeteredInteractiveWorkCount: input.journalSources.filter(
      (source) => source.dataName === `journal-${workItem}`,
    ).length,
  };
}

function compareRounds(a: ReviewRound, b: ReviewRound): number {
  return (
    a.workItem.localeCompare(b.workItem, undefined, { numeric: true }) ||
    a.phase.localeCompare(b.phase) ||
    a.round - b.round
  );
}

export function dedupeReviewRounds(rounds: ReviewRound[]): ReviewRound[] {
  const byCycle = new Map<string, ReviewRound>();
  for (const round of rounds) {
    const key = `${round.source.modelId}:${round.workItem}:${round.phase}:${round.round}`;
    const current = byCycle.get(key);
    const differentRuns =
      current?.workflowRunId !== undefined &&
      round.workflowRunId !== undefined &&
      current.workflowRunId !== round.workflowRunId;
    if (
      current === undefined ||
      (current.workflowRunId === undefined &&
        round.workflowRunId !== undefined) ||
      (current.workflowRunId === round.workflowRunId &&
        round.source.version < current.source.version) ||
      (differentRuns &&
        ((round.recordedAt ?? "") > (current.recordedAt ?? "") ||
          (round.recordedAt === current.recordedAt &&
            round.workflowRunId! > current.workflowRunId!)))
    ) {
      byCycle.set(key, round);
    }
  }
  return [...byCycle.values()].sort(compareRounds);
}

export function attributeInvocationRounds(
  invocations: Invocation[],
  rounds: ReviewRound[],
): Invocation[] {
  const timelines = groupBy(
    rounds,
    (round) => `${round.workItem}:${round.phase}`,
  );
  return invocations.map((value) => {
    const invocation = { ...value };
    if (invocation.round !== undefined) return invocation;
    const phase =
      invocation.phase ??
      (invocation.role === "planner"
        ? "plan"
        : invocation.role === "builder"
          ? "code"
          : undefined);
    if (phase === undefined || invocation.invokedAt === undefined) {
      return invocation;
    }
    invocation.phase = phase;
    const nextRound = (timelines[`${invocation.workItem}:${phase}`] ?? []).find(
      (round) =>
        round.recordedAt !== undefined &&
        round.recordedAt >= invocation.invokedAt!,
    );
    if (nextRound !== undefined) invocation.round = nextRound.round;
    return invocation;
  });
}

function compareInvocations(a: Invocation, b: Invocation): number {
  return (
    (a.invokedAt ?? "").localeCompare(b.invokedAt ?? "") ||
    a.source.dataName.localeCompare(b.source.dataName)
  );
}

function groupBy<T>(
  values: T[],
  key: (value: T) => string,
): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const value of values) (groups[key(value)] ??= []).push(value);
  return Object.fromEntries(
    Object.entries(groups).sort(([a], [b]) =>
      a.localeCompare(b, undefined, { numeric: true }),
    ),
  );
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

function measured(value: number | null, covered: number, total: number) {
  return value === null
    ? {
        value: null,
        availability: "unavailable",
        covered,
        total,
        reason: "No recorded values are available.",
      }
    : {
        value,
        availability: covered === total ? "available" : "partial",
        covered,
        total,
        ...(covered === total
          ? {}
          : { reason: "Only recorded provider values are included." }),
      };
}

function usageAggregate(
  invocations: Invocation[],
  unmeteredInteractiveWorkCount?: number,
) {
  const tokenFields = Object.fromEntries(
    TOKEN_FIELDS.map((field) => {
      const values = invocations
        .map((invocation) => invocation.tokens[field])
        .filter((value): value is number => value !== undefined);
      return [
        field,
        measured(
          values.length === 0
            ? null
            : values.reduce((sum, value) => sum + value, 0),
          values.length,
          invocations.length,
        ),
      ];
    }),
  );
  const costs = invocations
    .map((invocation) => invocation.providerReportedCostUsd)
    .filter((value): value is number => value !== undefined);
  const durations = invocations
    .map((invocation) => invocation.durationMs)
    .filter((value): value is number => value !== undefined);
  const retries = invocations
    .map((invocation) => invocation.retries)
    .filter((value): value is number => value !== undefined);
  const successes = invocations
    .map((invocation) => invocation.success)
    .filter((value): value is boolean => value !== undefined);
  const nonzero = costs.filter((value) => value > 0).length;
  const zero = costs.filter((value) => value === 0).length;
  return {
    invocationCount: invocations.length,
    tokenCoveredInvocationCount: invocations.filter(
      (invocation) => invocation.tokens.total !== undefined,
    ).length,
    nonzeroCostInvocationCount: nonzero,
    zeroCostInvocationCount: zero,
    costCoveredInvocationCount: costs.length,
    tokens: tokenFields,
    providerReportedCostUsd: measured(
      costs.length === 0 ? null : costs.reduce((sum, value) => sum + value, 0),
      costs.length,
      invocations.length,
    ),
    durationMs: measured(
      durations.length === 0
        ? null
        : durations.reduce((sum, value) => sum + value, 0),
      durations.length,
      invocations.length,
    ),
    retryCount: measured(
      retries.length === 0
        ? null
        : retries.reduce((sum, value) => sum + value, 0),
      retries.length,
      invocations.length,
    ),
    successRate: measured(
      successes.length === 0
        ? null
        : successes.filter((success) => success).length / successes.length,
      successes.length,
      invocations.length,
    ),
    unmeteredDriverWorkCount: {
      value: null,
      availability: "unavailable",
      reason:
        "The resident OpenCode driver is outside CLI-agent invocation records.",
    },
    unmeteredInteractiveWorkCount:
      unmeteredInteractiveWorkCount === undefined
        ? {
            value: null,
            availability: "unavailable",
            reason: "Interactive work cannot be allocated to this breakdown.",
          }
        : { value: unmeteredInteractiveWorkCount, availability: "available" },
  };
}

function usageBy(
  invocations: Invocation[],
  key: (invocation: Invocation) => string,
) {
  return Object.fromEntries(
    Object.entries(groupBy(invocations, key)).map(([name, group]) => [
      name,
      usageAggregate(group),
    ]),
  );
}

function subjects(rounds: ReviewRound[]) {
  return Object.values(
    groupBy(rounds, (round) => `${round.workItem}:${round.phase}`),
  ).map((values) => values.sort(compareRounds));
}

function firstRound(values: ReviewRound[], clean: boolean): number | null {
  const match = values.find((round) =>
    clean ? round.verdict === "pass" : round.verdict !== "fail",
  );
  return match?.round ?? null;
}

function kaplanMeier(rounds: ReviewRound[]) {
  const reviewSubjects = subjects(rounds);
  const maxRound = Math.max(0, ...rounds.map((round) => round.round));
  let mergeableSurvival = 1;
  let cleanSurvival = 1;
  const estimates = [];
  for (let round = 1; round <= maxRound; round++) {
    const measurement = (clean: boolean) => {
      const timelines = reviewSubjects.map((values) => ({
        event: firstRound(values, clean),
        last: values.at(-1)?.round ?? 0,
      }));
      const atRisk = timelines.filter(
        (timeline) =>
          timeline.last >= round &&
          (timeline.event === null || timeline.event >= round),
      ).length;
      const events = timelines.filter(
        (timeline) => timeline.event === round,
      ).length;
      const censored = timelines.filter(
        (timeline) => timeline.event === null && timeline.last === round,
      ).length;
      return { atRisk, events, censored };
    };
    const mergeable = measurement(false);
    const clean = measurement(true);
    if (mergeable.atRisk > 0) {
      mergeableSurvival *= 1 - mergeable.events / mergeable.atRisk;
    }
    if (clean.atRisk > 0) cleanSurvival *= 1 - clean.events / clean.atRisk;
    estimates.push({
      round,
      mergeable: {
        ...mergeable,
        conditionalProbability:
          mergeable.atRisk === 0 ? null : mergeable.events / mergeable.atRisk,
        cumulativeProbability: 1 - mergeableSurvival,
      },
      cleanPass: {
        ...clean,
        conditionalProbability:
          clean.atRisk === 0 ? null : clean.events / clean.atRisk,
        cumulativeProbability: 1 - cleanSurvival,
      },
    });
  }
  return estimates;
}

function firstMergeableCohorts(rounds: ReviewRound[], items: FactoryItem[]) {
  const bySubject = groupBy(
    rounds,
    (round) => `${round.workItem}:${round.phase}`,
  );
  return items.flatMap((item) =>
    (["plan", "code"] as const).map((phase) => {
      const values = bySubject[`${item.workItem}:${phase}`] ?? [];
      const firstMergeable = values.find((round) => round.verdict !== "fail");
      const firstCleanPass = values.find((round) => round.verdict === "pass");
      return {
        workItem: item.workItem,
        phase,
        firstMergeableRound: firstMergeable?.round ?? null,
        firstCleanPassRound: firstCleanPass?.round ?? null,
        censored: firstMergeable === undefined,
        outcome: item.outcome,
        lastObservedRound: values.at(-1)?.round ?? null,
        source: (firstMergeable ?? values.at(-1))?.source ?? item.source,
      };
    }),
  );
}

function laneAnalytics(rounds: ReviewRound[]) {
  const counts = Object.fromEntries(
    LANES.map((lane) => [lane, { pass: 0, warn: 0, fail: 0, unassessed: 0 }]),
  ) as Record<string, Record<Verdict | "unassessed", number>>;
  const appearedAfterClean = [];
  for (const values of subjects(rounds)) {
    const clean = new Set<string>();
    for (const round of values) {
      for (const lane of LANES) {
        const verdict = round.laneVerdicts[lane];
        if (verdict === undefined) {
          counts[lane].unassessed += 1;
          continue;
        }
        counts[lane][verdict] += 1;
        if (clean.has(lane) && verdict !== "pass") {
          appearedAfterClean.push({
            workItem: round.workItem,
            phase: round.phase,
            round: round.round,
            lane,
            verdict,
            source: round.source,
          });
        }
        if (verdict === "pass") clean.add(lane);
      }
    }
  }
  return { counts, appearedAfterClean };
}

function periodAnalytics(
  items: FactoryItem[],
  rounds: ReviewRound[],
  invocations: Invocation[],
) {
  const monthByWorkItem = new Map(
    items.map((item) => [
      item.workItem,
      item.startedAt?.slice(0, 7) ?? "unavailable",
    ]),
  );
  const itemGroups = groupBy(items, (item) =>
    monthByWorkItem.get(item.workItem)!,
  );
  return Object.fromEntries(
    Object.entries(itemGroups).map(([month, periodItems]) => {
      const workItems = new Set(periodItems.map((item) => item.workItem));
      const periodRounds = rounds.filter((round) =>
        workItems.has(round.workItem),
      );
      const perSubjectRounds = subjects(periodRounds).map(
        (values) => values.at(-1)?.round ?? 0,
      );
      const periodInvocations = invocations.filter((invocation) =>
        workItems.has(invocation.workItem),
      );
      const perItem = Object.values(
        groupBy(periodInvocations, (invocation) => invocation.workItem),
      );
      const completeTokenTotals = perItem
        .filter((values) =>
          values.every((value) => value.tokens.total !== undefined),
        )
        .map((values) =>
          values.reduce((sum, value) => sum + value.tokens.total!, 0),
        );
      const completeCosts = perItem
        .filter((values) =>
          values.every((value) => value.providerReportedCostUsd !== undefined),
        )
        .map((values) =>
          values.reduce(
            (sum, value) => sum + value.providerReportedCostUsd!,
            0,
          ),
        );
      return [
        month,
        {
          startedWorkItems: periodItems.length,
          deliveredWorkItems: periodItems.filter(
            (item) => item.outcome === "done",
          ).length,
          medianReviewRounds: median(perSubjectRounds),
          medianTokensPerWorkItem: measured(
            median(completeTokenTotals),
            completeTokenTotals.length,
            perItem.length,
          ),
          medianProviderReportedCostUsdPerWorkItem: measured(
            median(completeCosts),
            completeCosts.length,
            perItem.length,
          ),
        },
      ];
    }),
  );
}

function reviewEffectiveness(input: AnalyticsInput) {
  const rounds = input.reviewRounds;
  const lanes = laneAnalytics(rounds);
  const totalRounds = rounds.length;
  const planRounds = rounds.filter((round) => round.phase === "plan").length;
  const codeRounds = totalRounds - planRounds;
  const marginal = kaplanMeier(rounds);
  const outcomes = new Map(
    input.factoryItems.map((item) => [item.workItem, item.outcome]),
  );
  const openSubjects = subjects(rounds).filter(
    (values) =>
      firstRound(values, false) === null &&
      outcomes.get(values[0].workItem) === "in-flight",
  );
  const zeroGainTail = marginal.find(
    (row, index) =>
      row.round >= 2 &&
      row.mergeable.atRisk > 0 &&
      marginal
        .slice(index)
        .every((candidate) => candidate.mergeable.events === 0) &&
      openSubjects.length === 0,
  );
  const elbow = zeroGainTail === undefined ? null : zeroGainTail.round - 1;
  return {
    kaplanMeier: {
      unit: "work-item review-phase",
      observedSubjectCount: subjects(rounds).length,
      unobservedSubjectCount:
        input.factoryItems.length * 2 - subjects(rounds).length,
      population:
        "Estimates use phases with at least one observed review round; unobserved phases are listed as censored at round 0 in firstMergeable.",
      all: marginal,
      plan: kaplanMeier(rounds.filter((round) => round.phase === "plan")),
      code: kaplanMeier(rounds.filter((round) => round.phase === "code")),
    },
    firstMergeable: firstMergeableCohorts(rounds, input.factoryItems),
    reviewRoundSplit: {
      planRounds,
      codeRounds,
      planPercent: totalRounds === 0 ? null : planRounds / totalRounds,
      codePercent: totalRounds === 0 ? null : codeRounds / totalRounds,
      mandibleBenchmark: { planPercent: 0.19, codePercent: 0.81 },
    },
    laneVerdicts: lanes.counts,
    findingsAfterPreviouslyCleanLane: lanes.appearedAfterClean,
    unassessedLaneCount: Object.values(lanes.counts).reduce(
      (sum, counts) => sum + counts.unassessed,
      0,
    ),
    configurationFailureCount: Object.values(input.failureWorkflowKinds).filter(
      (failure) => failure.kind === "configuration",
    ).length,
    infrastructureFailureCount: Object.values(
      input.failureWorkflowKinds,
    ).filter((failure) => failure.kind === "infrastructure").length,
    periods: periodAnalytics(input.factoryItems, rounds, input.invocations),
    marginalMergeabilityElbow:
      elbow === null
        ? {
            value: null,
            availability: "unavailable",
            reason:
              "No observed round is followed only by zero mergeability gains.",
          }
        : {
            value: elbow,
            availability: "available",
            definition:
              "Last round with an observed first-mergeable event before a resolved zero-gain tail.",
          },
  };
}

function workItemCohorts(input: AnalyticsInput) {
  const roundsByItem = groupBy(input.reviewRounds, (round) => round.workItem);
  const cohorts = {
    "all-started": new Set<string>(),
    mergeable: new Set<string>(),
    "clean-pass": new Set<string>(),
    "never-clean-pass": new Set<string>(),
    censored: new Set<string>(),
  };
  for (const item of input.factoryItems) {
    const itemRounds = roundsByItem[item.workItem] ?? [];
    const mergeable = itemRounds.some((round) => round.verdict !== "fail");
    const clean = itemRounds.some((round) => round.verdict === "pass");
    cohorts["all-started"].add(item.workItem);
    if (mergeable) cohorts.mergeable.add(item.workItem);
    if (clean) cohorts["clean-pass"].add(item.workItem);
    else cohorts["never-clean-pass"].add(item.workItem);
    if (!mergeable) cohorts.censored.add(item.workItem);
  }
  return cohorts;
}

function firstPathInvocations(invocations: Invocation[]) {
  const selected = new Set<string>();
  for (const values of Object.values(
    groupBy(invocations, (value) => value.workItem),
  )) {
    for (const role of ["planner", "builder"] as const) {
      const roleValues = values.filter((value) => value.role === role);
      const firstRun = roleValues[0]?.workflowRunId;
      if (firstRun === undefined && roleValues[0] !== undefined) {
        selected.add(roleValues[0].source.dataName);
      }
      for (const value of roleValues) {
        if (firstRun !== undefined && value.workflowRunId === firstRun)
          selected.add(value.source.dataName);
      }
    }
    for (const value of values) {
      if (value.role === "reviewer" && value.round === 1) {
        selected.add(value.source.dataName);
      }
    }
  }
  return invocations.filter((value) => selected.has(value.source.dataName));
}

function ratio(value: number | null, denominator: number | null) {
  return value === null || denominator === null || denominator === 0
    ? null
    : value / denominator;
}

function averagePerWorkItem(
  invocations: Invocation[],
  workItems: Set<string>,
  value: (invocation: Invocation) => number | undefined,
) {
  const byWorkItem = groupBy(
    invocations.filter((invocation) => workItems.has(invocation.workItem)),
    (invocation) => invocation.workItem,
  );
  const totals = [...workItems].flatMap((workItem) => {
    const values = byWorkItem[workItem] ?? [];
    if (
      values.length === 0 ||
      values.some((invocation) => value(invocation) === undefined)
    ) {
      return [];
    }
    return [values.reduce((sum, invocation) => sum + value(invocation)!, 0)];
  });
  return measured(
    totals.length === 0
      ? null
      : totals.reduce((sum, total) => sum + total, 0) / totals.length,
    totals.length,
    workItems.size,
  );
}

function efficiencyIndicators(
  input: AnalyticsInput,
  firstMergeable: ReturnType<typeof firstMergeableCohorts>,
  resurfaced: ReturnType<typeof laneAnalytics>["appearedAfterClean"],
) {
  const outcome = new Map(
    input.factoryItems.map((item) => [item.workItem, item.outcome]),
  );
  const firstBySubject = new Map(
    firstMergeable.map((item) => [
      `${item.workItem}:${item.phase}`,
      item.firstMergeableRound,
    ]),
  );
  const throughFirstMergeable = input.invocations.filter((invocation) => {
    if (invocation.phase === undefined || invocation.round === undefined)
      return false;
    const first = firstBySubject.get(
      `${invocation.workItem}:${invocation.phase}`,
    );
    return first !== null && first !== undefined && invocation.round <= first;
  });
  const afterFirstMergeable = input.invocations.filter((invocation) => {
    if (invocation.phase === undefined || invocation.round === undefined)
      return false;
    const first = firstBySubject.get(
      `${invocation.workItem}:${invocation.phase}`,
    );
    return first !== null && first !== undefined && invocation.round > first;
  });
  const resurfacedKeys = new Set(
    resurfaced.map(
      (item) => `${item.workItem}:${item.phase}:${item.round}:${item.lane}`,
    ),
  );
  const resurfacedUsage = input.invocations.filter(
    (invocation) =>
      invocation.phase !== undefined &&
      invocation.round !== undefined &&
      invocation.lane !== undefined &&
      resurfacedKeys.has(
        `${invocation.workItem}:${invocation.phase}:${invocation.round}:${invocation.lane}`,
      ),
  );
  const failureWaste = input.invocations.filter((invocation) => {
    const kind = invocation.workflowRunId
      ? input.failureWorkflowKinds[invocation.workflowRunId]?.kind
      : undefined;
    return (
      kind === "configuration" ||
      kind === "infrastructure" ||
      invocation.failureClass === "configuration" ||
      invocation.failureClass === "infrastructure"
    );
  });
  const firstPath = firstPathInvocations(input.invocations);
  const rework = input.invocations.filter(
    (invocation) =>
      !firstPath.some(
        (candidate) => candidate.source.dataName === invocation.source.dataName,
      ),
  );
  const delivered = new Set(
    input.factoryItems
      .filter((item) => item.outcome === "done")
      .map((item) => item.workItem),
  );
  const mergeableItems = new Set(
    firstMergeable
      .filter((item) => item.firstMergeableRound !== null)
      .map((item) => item.workItem),
  );
  const totalUsage = usageAggregate(input.invocations);
  const firstUsage = usageAggregate(firstPath);
  const reworkUsage = usageAggregate(rework);
  const reviewPathInvocations = input.invocations.filter(
    (invocation) =>
      invocation.phase !== undefined &&
      ["planner", "builder", "reviewer"].includes(invocation.role),
  );
  const attributedReviewPath = reviewPathInvocations.filter(
    (invocation) => invocation.round !== undefined,
  );
  const cacheByProviderModel = Object.fromEntries(
    Object.entries(
      groupBy(
        input.invocations,
        (invocation) => `${invocation.provider}/${invocation.model}`,
      ),
    ).map(([name, values]) => {
      const covered = values.filter(
        (value) =>
          value.tokens.cacheRead !== undefined &&
          value.tokens.input !== undefined,
      );
      const cacheRead = covered.reduce(
        (sum, value) => sum + value.tokens.cacheRead!,
        0,
      );
      const inputTokens = covered.reduce(
        (sum, value) => sum + value.tokens.input!,
        0,
      );
      return [
        name,
        {
          cacheReadTokens: cacheRead,
          inputTokens,
          cacheReadRatio: measured(
            cacheRead + inputTokens === 0
              ? null
              : cacheRead / (cacheRead + inputTokens),
            covered.length,
            values.length,
          ),
          disclosure:
            "Providers account for cached and reasoning tokens differently; ratios are not normalized across providers.",
        },
      ];
    }),
  );
  return {
    delivered: {
      workItemCount: delivered.size,
      tokensPerDeliveredWorkItem: averagePerWorkItem(
        input.invocations,
        delivered,
        (invocation) => invocation.tokens.total,
      ),
      providerReportedCostUsdPerDeliveredWorkItem: averagePerWorkItem(
        input.invocations,
        delivered,
        (invocation) => invocation.providerReportedCostUsd,
      ),
    },
    mergeable: {
      workItemCount: mergeableItems.size,
      providerReportedCostUsdPerMergeableWorkItem: averagePerWorkItem(
        input.invocations,
        mergeableItems,
        (invocation) => invocation.providerReportedCostUsd,
      ),
    },
    toFirstMergeableReview: usageAggregate(throughFirstMergeable),
    toFirstMergeableByPhase: {
      plan: usageAggregate(
        throughFirstMergeable.filter((value) => value.phase === "plan"),
      ),
      code: usageAggregate(
        throughFirstMergeable.filter((value) => value.phase === "code"),
      ),
    },
    afterFirstMergeableReview: usageAggregate(afterFirstMergeable),
    afterFirstMergeableByPhase: {
      plan: usageAggregate(
        afterFirstMergeable.filter((value) => value.phase === "plan"),
      ),
      code: usageAggregate(
        afterFirstMergeable.filter((value) => value.phase === "code"),
      ),
    },
    afterReviewRound4: usageAggregate(
      input.invocations.filter((value) => (value.round ?? 0) > 4),
    ),
    reviewRoundAttribution: measured(
      reviewPathInvocations.length === 0
        ? null
        : attributedReviewPath.length / reviewPathInvocations.length,
      attributedReviewPath.length,
      reviewPathInvocations.length,
    ),
    unattributedReviewPathUsage: usageAggregate(
      reviewPathInvocations.filter(
        (invocation) => invocation.round === undefined,
      ),
    ),
    reworkMultiplierOverFirstPath: {
      tokens: ratio(
        reworkUsage.tokens.total.value,
        firstUsage.tokens.total.value,
      ),
      providerReportedCostUsd: ratio(
        reworkUsage.providerReportedCostUsd.value,
        firstUsage.providerReportedCostUsd.value,
      ),
      firstPath: firstUsage,
      rework: reworkUsage,
      definition:
        "Rework is recorded usage outside the first planner workflow, first builder workflow, and round-1 plan/code reviews.",
    },
    reviewByRound: usageBy(
      input.invocations.filter((value) => value.round !== undefined),
      (value) => String(value.round),
    ),
    findingsAfterPreviouslyCleanLane: usageAggregate(resurfacedUsage),
    configurationInfrastructureFailureWaste: usageAggregate(failureWaste),
    failedInvocations: usageAggregate(
      input.invocations.filter((value) => value.success === false),
    ),
    retriedInvocations: usageAggregate(
      input.invocations.filter((value) => (value.retries ?? 0) > 0),
    ),
    parkedWork: usageAggregate(
      input.invocations.filter(
        (value) => outcome.get(value.workItem) === "parked",
      ),
    ),
    abortedWork: usageAggregate(
      input.invocations.filter(
        (value) => outcome.get(value.workItem) === "aborted",
      ),
    ),
    cacheByProviderModel,
    total: totalUsage,
  };
}

export function analyzeNightshift(input: AnalyticsInput) {
  const ownerByWorkItem = new Map<string, string>();
  for (const item of input.factoryItems) {
    const owner = ownerByWorkItem.get(item.workItem);
    if (owner !== undefined && owner !== item.source.modelId) {
      throw new Error(
        `work item '${item.workItem}' has multiple factory owners; analytics unavailable`,
      );
    }
    ownerByWorkItem.set(item.workItem, item.source.modelId);
  }
  const workItems = new Set(input.factoryItems.map((item) => item.workItem));
  const joinedInput = {
    ...input,
    reviewRounds: input.reviewRounds.filter(
      (round) =>
        isCanonicalWorkItem(round.workItem) && workItems.has(round.workItem),
    ),
    invocations: input.invocations.filter(
      (invocation) =>
        isCanonicalWorkItem(invocation.workItem) &&
        workItems.has(invocation.workItem),
    ),
  };
  const review = reviewEffectiveness(joinedInput);
  const outcome = new Map(
    joinedInput.factoryItems.map((item) => [item.workItem, item.outcome]),
  );
  const cohorts = workItemCohorts(joinedInput);
  const usage = {
    total: usageAggregate(
      joinedInput.invocations,
      joinedInput.unmeteredInteractiveWorkCount,
    ),
    byWorkItem: usageBy(joinedInput.invocations, (value) => value.workItem),
    byStage: usageBy(joinedInput.invocations, (value) => value.stage),
    byReviewPhase: usageBy(
      joinedInput.invocations.filter((value) => value.phase !== undefined),
      (value) => value.phase!,
    ),
    byReviewRound: usageBy(
      joinedInput.invocations.filter((value) => value.round !== undefined),
      (value) => String(value.round),
    ),
    byReviewLane: usageBy(
      joinedInput.invocations.filter((value) => value.lane !== undefined),
      (value) => value.lane!,
    ),
    byRole: usageBy(joinedInput.invocations, (value) => value.role),
    byProvider: usageBy(joinedInput.invocations, (value) => value.provider),
    byModel: usageBy(joinedInput.invocations, (value) => value.model),
    byOutcome: usageBy(
      joinedInput.invocations,
      (value) => outcome.get(value.workItem) ?? "unattributed",
    ),
    byCohort: Object.fromEntries(
      Object.entries(cohorts).map(([name, workItems]) => [
        name,
        usageAggregate(
          joinedInput.invocations.filter((value) =>
            workItems.has(value.workItem),
          ),
        ),
      ]),
    ),
    invocations: joinedInput.invocations,
  };
  const perWorkItemGroups = Object.values(
    groupBy(joinedInput.invocations, (value) => value.workItem),
  );
  const perWorkItemCosts = perWorkItemGroups
    .filter((values) =>
      values.every((value) => value.providerReportedCostUsd !== undefined),
    )
    .map((values) =>
      values.reduce((sum, value) => sum + value.providerReportedCostUsd!, 0),
    );
  return {
    schemaVersion: 1,
    deterministic: true,
    usageSemantics: {
      cost: "providerReportedCostUsd is recorded invocation.attributes.costUsd. Zero means provider-reported zero, not free.",
      tokens:
        "Provider-normalized total is reported as supplied; cache-read and cache-write are not added to total.",
      driver:
        "Resident OpenCode driver orchestration usage is unavailable, not zero.",
      cohorts:
        "Cohorts overlap: mergeable has any warn/pass round, clean-pass has any pass round, never-clean-pass has no pass round, and censored has no mergeable round.",
    },
    coverage: {
      factoryWorkItemCount: joinedInput.factoryItems.length,
      reviewRoundCount: joinedInput.reviewRounds.length,
      malformedWorkItems: joinedInput.malformedWorkItems,
      ...usage.total,
    },
    reviewEffectiveness: review,
    usage,
    costDistributionPerWorkItem: {
      medianProviderReportedCostUsd: measured(
        median(perWorkItemCosts),
        perWorkItemCosts.length,
        perWorkItemGroups.length,
      ),
      p90ProviderReportedCostUsd: measured(
        percentile(perWorkItemCosts, 0.9),
        perWorkItemCosts.length,
        perWorkItemGroups.length,
      ),
      p95ProviderReportedCostUsd: measured(
        percentile(perWorkItemCosts, 0.95),
        perWorkItemCosts.length,
        perWorkItemGroups.length,
      ),
      coveredWorkItemCount: perWorkItemCosts.length,
    },
    efficiency: efficiencyIndicators(
      joinedInput,
      review.firstMergeable,
      review.findingsAfterPreviouslyCleanLane,
    ),
    sourcePointers: {
      factory: joinedInput.factoryItems.map((item) => item.source),
      reviews: joinedInput.reviewRounds.map((round) => round.source),
      evidence: joinedInput.evidenceSources,
      journal: joinedInput.journalSources,
      invocations: joinedInput.invocations.map(
        (invocation) => invocation.source,
      ),
    },
  };
}

function formatNumber(value: number | null, digits = 2): string {
  return value === null
    ? "unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function formatPercent(value: number | null): string {
  return value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

function formatMeasured(
  value: { value: number | null; covered: number; total: number },
  digits = 2,
): string {
  return `${formatNumber(value.value, digits)} (${value.covered}/${value.total} covered)`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
}

function renderUsageTable(
  title: string,
  groups: Record<string, ReturnType<typeof usageAggregate>>,
) {
  const lines = [
    `### ${title}`,
    "",
    "| Group | Invocations | Token-covered | Nonzero cost | Zero cost | Total tokens | Provider-reported cost USD | Unmetered interactive | Driver usage |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const [name, value] of Object.entries(groups)) {
    lines.push(
      `| ${escapeCell(name)} | ${value.invocationCount} | ${value.tokenCoveredInvocationCount} | ${value.nonzeroCostInvocationCount} | ${value.zeroCostInvocationCount} | ${formatNumber(value.tokens.total.value, 0)} | ${formatNumber(value.providerReportedCostUsd.value, 4)} | ${value.unmeteredInteractiveWorkCount.value ?? "unavailable"} | ${value.unmeteredDriverWorkCount.value ?? "unavailable"} |`,
    );
  }
  return lines.join("\n");
}

export function renderMarkdown(
  analytics: ReturnType<typeof analyzeNightshift>,
) {
  const coverage = analytics.coverage;
  const total = analytics.usage.total;
  const lines = [
    "# Nightshift Factory Analytics",
    "",
    "Static analysis of factory review history joined to CLI-agent invocations by work item and workflow run ID.",
    "",
    "## Coverage",
    "",
    "| Factory items | Review rounds | Invocations | Token-covered | Nonzero cost | Zero cost | Unmetered interactive | Driver usage |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    `| ${coverage.factoryWorkItemCount} | ${coverage.reviewRoundCount} | ${coverage.invocationCount} | ${coverage.tokenCoveredInvocationCount} | ${coverage.nonzeroCostInvocationCount} | ${coverage.zeroCostInvocationCount} | ${coverage.unmeteredInteractiveWorkCount.value ?? "unavailable"} | unavailable |`,
    "",
    "A provider-reported zero cost is not interpreted as free. Resident driver orchestration usage is unavailable, not zero. Provider token accounting is not normalized across providers.",
    "",
    "## Review Effectiveness",
    "",
    "| Round | At risk | First mergeable | P(mergeable this round \\| not yet) | KM mergeable | First clean pass | KM clean pass |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of analytics.reviewEffectiveness.kaplanMeier.all) {
    lines.push(
      `| ${row.round} | ${row.mergeable.atRisk} | ${row.mergeable.events} | ${formatPercent(row.mergeable.conditionalProbability)} | ${formatPercent(row.mergeable.cumulativeProbability)} | ${row.cleanPass.events} | ${formatPercent(row.cleanPass.cumulativeProbability)} |`,
    );
  }
  lines.push(
    "",
    `Plan/code round split: ${analytics.reviewEffectiveness.reviewRoundSplit.planRounds}/${analytics.reviewEffectiveness.reviewRoundSplit.codeRounds} (${formatPercent(analytics.reviewEffectiveness.reviewRoundSplit.planPercent)}/${formatPercent(analytics.reviewEffectiveness.reviewRoundSplit.codePercent)}; Mandible reference 19%/81%).`,
    "",
    `Marginal mergeability elbow: ${analytics.reviewEffectiveness.marginalMergeabilityElbow.value ?? "unavailable"}.`,
    "",
    "### Lane Verdicts",
    "",
    "| Lane | Pass | Warn | Fail | Unassessed |",
    "| --- | ---: | ---: | ---: | ---: |",
  );
  for (const [lane, counts] of Object.entries(
    analytics.reviewEffectiveness.laneVerdicts,
  )) {
    lines.push(
      `| ${lane} | ${counts.pass} | ${counts.warn} | ${counts.fail} | ${counts.unassessed} |`,
    );
  }
  lines.push(
    "",
    `Findings after a lane was previously clean: ${analytics.reviewEffectiveness.findingsAfterPreviouslyCleanLane.length}. Configuration failures: ${analytics.reviewEffectiveness.configurationFailureCount}. Infrastructure failures: ${analytics.reviewEffectiveness.infrastructureFailureCount}.`,
    "",
    "## LLM Usage",
    "",
    `Total provider-reported cost: $${formatNumber(total.providerReportedCostUsd.value, 4)}. Total provider-normalized tokens: ${formatNumber(total.tokens.total.value, 0)}. Duration: ${formatNumber(total.durationMs.value, 0)} ms. Retries: ${formatNumber(total.retryCount.value, 0)}. Success rate: ${formatPercent(total.successRate.value)}.`,
    "",
    renderUsageTable("By Stage", analytics.usage.byStage),
    "",
    renderUsageTable("By Review Round", analytics.usage.byReviewRound),
    "",
    renderUsageTable("By Review Lane", analytics.usage.byReviewLane),
    "",
    renderUsageTable("By Provider", analytics.usage.byProvider),
    "",
    renderUsageTable("By Model", analytics.usage.byModel),
    "",
    renderUsageTable("By Outcome", analytics.usage.byOutcome),
    "",
    "Cohorts overlap; they are not partitions of total usage.",
    "",
    renderUsageTable("By Cohort", analytics.usage.byCohort),
    "",
    "## Efficiency",
    "",
    `Tokens per delivered item: ${formatMeasured(analytics.efficiency.delivered.tokensPerDeliveredWorkItem, 0)}. Provider-reported cost per delivered item: $${formatMeasured(analytics.efficiency.delivered.providerReportedCostUsdPerDeliveredWorkItem, 4)}.`,
    "",
    `Rework multiplier over the first path: ${formatNumber(analytics.efficiency.reworkMultiplierOverFirstPath.tokens)}x tokens, ${formatNumber(analytics.efficiency.reworkMultiplierOverFirstPath.providerReportedCostUsd)}x provider-reported cost.`,
    "",
    `Usage after review round 4: ${formatNumber(analytics.efficiency.afterReviewRound4.tokens.total.value, 0)} tokens, $${formatNumber(analytics.efficiency.afterReviewRound4.providerReportedCostUsd.value, 4)} provider-reported cost.`,
    "",
    `Review-path round attribution: ${formatPercent(analytics.efficiency.reviewRoundAttribution.value)} (${analytics.efficiency.reviewRoundAttribution.covered}/${analytics.efficiency.reviewRoundAttribution.total} invocations).`,
    "",
    "Full per-invocation values, period medians, Kaplan-Meier phase estimates, cost percentiles, cache ratios, censored cohorts, and source pointers are retained in JSON.",
  );
  return `${lines
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

export const report = {
  name: "@funsaized/nightshift-factory-analytics",
  description:
    "Deterministic Nightshift review effectiveness, token usage, and provider-reported cost analytics with factory and CLI-agent source pointers; no LLM.",
  scope: "method",
  labels: ["software-factory", "nightshift", "analytics"],
  execute: async (context: ReportContext) => {
    if (
      String(context.modelType) !== FACTORY_TYPE ||
      context.methodName !== "summary"
    ) {
      return { markdown: "", json: {} };
    }
    if (context.executionStatus !== "succeeded") {
      const error = context.errorMessage ?? "unknown error";
      return {
        markdown: `# Nightshift Factory Analytics\n\n_Analytics unavailable: ${error}_\n`,
        json: { error, availability: "unavailable" },
      };
    }
    const scopeWorkItem = stringValue(context.methodArgs.workItem);
    const input = await loadFactoryInput(context);
    const analytics = analyzeNightshift(
      scopeWorkItem === undefined ? input : scopeInput(input, scopeWorkItem),
    );
    return {
      markdown: renderMarkdown(analytics),
      json: {
        factory: context.definition?.name ?? "the-nightshift",
        method: context.methodName,
        scopeWorkItem: scopeWorkItem ?? null,
        ...analytics,
      },
    };
  },
};
