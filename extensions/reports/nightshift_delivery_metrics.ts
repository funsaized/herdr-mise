/** Delivery timing derived from recorded events, never inferred human waits. */
import type {
  Invocation,
  SourcePointer,
} from "./nightshift_review_analytics.ts";

export interface JournalEvent {
  workItem: string;
  event: string;
  stageId: string;
  at: string;
  source: SourcePointer;
}

export interface DeliveryEvidence {
  workItem: string;
  name: string;
  stageId: string;
  cycle: number;
  recordedAt?: string;
  payload: Record<string, unknown>;
  source: SourcePointer;
}

function time(value: string | undefined): number | null {
  const result = value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function distribution(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const count = ordered.length;
  return {
    count,
    medianMs:
      count === 0
        ? null
        : count % 2
          ? ordered[Math.floor(count / 2)]
          : (ordered[count / 2 - 1] + ordered[count / 2]) / 2,
    p95Ms: count === 0 ? null : ordered[Math.ceil(count * 0.95) - 1],
  };
}

function unionDuration(intervals: Array<[number, number]>): number {
  let end = -Infinity;
  let total = 0;
  for (const [start, stop] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}

export function deliveryMetrics(
  workItems: string[],
  journal: JournalEvent[],
  evidence: DeliveryEvidence[],
  invocations: Invocation[],
) {
  const cohort = new Set(workItems);
  const events = journal.filter((event) => cohort.has(event.workItem));
  const records = evidence.filter((record) => cohort.has(record.workItem));
  const invalidTimestamps = events.filter((event) => time(event.at) === null);
  const visits: Array<{
    workItem: string;
    stageId: string;
    enteredAt: string;
    exitedAt: string | null;
    residenceMs: number | null;
    timeToFirstDispatchMs: number | null;
    observedAgentExecutionMs: number | null;
    unattributedMs: number | null;
    dispatches: number;
    source: SourcePointer;
  }> = [];
  let invalidOrdering = 0;
  for (const workItem of cohort) {
    // Versions are append order. Sorting by timestamps would hide clock regressions.
    const itemEvents = events
      .filter((event) => event.workItem === workItem)
      .sort((a, b) => a.source.version - b.source.version);
    let entry: JournalEvent | undefined;
    let dispatches: JournalEvent[] = [];
    const close = (exit?: JournalEvent) => {
      if (!entry) return;
      const start = time(entry.at);
      const end = exit ? time(exit.at) : null;
      const valid = start !== null && end !== null && end >= start;
      if (start !== null && end !== null && end < start) invalidOrdering++;
      const durations = invocations
        .filter((invocation) => invocation.workItem === workItem)
        .flatMap((invocation): Array<[number, number]> => {
          const began = time(invocation.invokedAt);
          const duration = invocation.durationMs;
          if (
            !valid ||
            began === null ||
            duration === undefined ||
            duration < 0 ||
            !Number.isFinite(duration)
          )
            return [];
          const left = Math.max(start!, began);
          const right = Math.min(end!, began + duration);
          return right > left ? [[left, right]] : [];
        });
      const execution =
        valid && durations.length ? unionDuration(durations) : null;
      const first = dispatches.length ? time(dispatches[0].at) : null;
      visits.push({
        workItem,
        stageId: entry.stageId,
        enteredAt: entry.at,
        exitedAt: exit?.at ?? null,
        residenceMs: valid ? end! - start! : null,
        timeToFirstDispatchMs:
          start !== null &&
          first !== null &&
          first >= start &&
          (end === null || first <= end)
            ? first - start
            : null,
        observedAgentExecutionMs: execution,
        unattributedMs:
          valid && execution !== null ? end! - start! - execution : null,
        dispatches: dispatches.length,
        source: entry.source,
      });
    };
    for (const event of itemEvents) {
      if (["started", "advanced", "run_terminal"].includes(event.event)) {
        close(event);
        entry = event.event === "run_terminal" ? undefined : event;
        dispatches = [];
      } else if (
        event.event === "dispatched" &&
        event.stageId === entry?.stageId
      ) {
        dispatches.push(event);
      }
    }
    close();
  }
  const failures = records
    .filter((record) => record.payload.status === "failed")
    .map((record) => {
      const outputs = object(record.payload.outputs);
      return {
        workItem: record.workItem,
        stageId: record.stageId,
        cycle: record.cycle,
        runId:
          typeof record.payload.runId === "string"
            ? record.payload.runId
            : null,
        classification: [
          "candidate",
          "configuration",
          "infrastructure",
        ].includes(String(outputs.failureKind))
          ? String(outputs.failureKind)
          : "unknown",
        failedStep:
          typeof outputs.failedStep === "string" ? outputs.failedStep : null,
        reason: typeof outputs.reason === "string" ? outputs.reason : null,
        source: record.source,
      };
    });
  return {
    semantics: {
      residence:
        "Closed stage entry to next transition; open and malformed intervals are unavailable.",
      execution:
        "Union of recorded agent invocation intervals clipped to each visit; excludes unmetered driver and non-agent execution.",
      unattributed:
        "Residual elapsed time, not a claim of idle, queue, or human wait.",
      humanWait:
        "Unavailable until gate-ready and decision events establish the waiting interval.",
      failures:
        "Recorded classifications, not independently adjudicated root causes; repeated records can refer to one run.",
    },
    coverage: {
      workItems: cohort.size,
      withJournal: new Set(events.map((event) => event.workItem)).size,
      invalidTimestampCount: invalidTimestamps.length,
      invalidOrderingCount: invalidOrdering,
      closedVisits: visits.filter((visit) => visit.residenceMs !== null).length,
      openVisits: visits.filter((visit) => visit.exitedAt === null).length,
      visitsWithAgentTiming: visits.filter(
        (visit) => visit.observedAgentExecutionMs !== null,
      ).length,
      humanWaitMs: null,
    },
    byStage: Object.fromEntries(
      [...new Set(visits.map((visit) => visit.stageId))].sort().map((stage) => {
        const selected = visits.filter((visit) => visit.stageId === stage);
        return [
          stage,
          {
            visits: selected.length,
            redispatches: selected.reduce(
              (sum, visit) => sum + Math.max(0, visit.dispatches - 1),
              0,
            ),
            residence: distribution(
              selected.flatMap((visit) =>
                visit.residenceMs === null ? [] : [visit.residenceMs],
              ),
            ),
            firstDispatch: distribution(
              selected.flatMap((visit) =>
                visit.timeToFirstDispatchMs === null
                  ? []
                  : [visit.timeToFirstDispatchMs],
              ),
            ),
          },
        ];
      }),
    ),
    visits,
    failures,
    candidates: records
      .filter((record) => record.name === "release-candidate")
      .map((record) => ({
        workItem: record.workItem,
        recordedAt: record.recordedAt ?? null,
        commit: record.payload.commit ?? null,
        baseCommit: record.payload.baseCommit ?? null,
        prUrl: record.payload.prUrl ?? null,
        source: record.source,
      })),
    managedResults: records
      .filter((record) => record.name === "managed-verification")
      .map((record) => ({
        workItem: record.workItem,
        recordedAt: record.recordedAt ?? null,
        payload: record.payload,
        source: record.source,
      })),
  };
}
