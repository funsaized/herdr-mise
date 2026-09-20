import {
  deliveryMetrics,
  type JournalEvent,
} from "../reports/nightshift_delivery_metrics.ts";
import type { Invocation } from "../reports/nightshift_review_analytics.ts";
import fixture from "./fixtures/nightshift-journal-144.json" with { type: "json" };

const journal: JournalEvent[] = fixture.map((event, index) => ({
  workItem: event.workItem,
  event: event.event,
  stageId: event.stageId,
  at: event.at,
  source: {
    plane: "factory",
    modelName: "nightshift-run-144",
    modelId: "fixture-144",
    dataName: "journal-144",
    version: index + 1,
  },
}));
const invocation = (at: string, durationMs: number): Invocation => ({
  workItem: "144",
  provider: "fixture",
  model: "fixture",
  role: "planner",
  stage: "plan",
  tokens: {},
  invokedAt: at,
  durationMs,
  source: journal[0].source,
});
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

Deno.test("retained journal distinguishes closed residence, redispatch, and open visits", () => {
  const result = deliveryMetrics(["144", "145"], journal, [], []);
  equal(result.coverage.withJournal, 1);
  equal(result.coverage.closedVisits, 1);
  equal(result.coverage.openVisits, 1);
  equal(result.byStage.planning.redispatches, 1);
  equal(
    result.visits[0].residenceMs,
    Date.parse(fixture[6].at) - Date.parse(fixture[0].at),
  );
  equal(result.visits[0].timeToFirstDispatchMs, 38557);
  equal(result.visits[0].observedAgentExecutionMs, null);
  equal(result.coverage.humanWaitMs, null);
});

Deno.test("overlapping agent intervals are clipped and counted once", () => {
  const start = Date.parse(fixture[0].at);
  const result = deliveryMetrics(
    ["144"],
    journal,
    [],
    [
      invocation(new Date(start - 1000).toISOString(), 3000),
      invocation(new Date(start + 1000).toISOString(), 4000),
      invocation("malformed", 5000),
      invocation(new Date(start).toISOString(), -1),
    ],
  );
  equal(result.visits[0].observedAgentExecutionMs, 5000);
  equal(result.visits[0].unattributedMs, result.visits[0].residenceMs! - 5000);
});

Deno.test("malformed and reversed clocks never become valid durations", () => {
  const reversed = [journal[0], { ...journal[6], at: "2026-01-01T00:00:00Z" }];
  equal(
    deliveryMetrics(["144"], reversed, [], []).coverage.invalidOrderingCount,
    1,
  );
  const malformed = [{ ...journal[0], at: "bad" }, journal[6]];
  const result = deliveryMetrics(["144"], malformed, [], []);
  equal(result.coverage.invalidTimestampCount, 1);
  equal(result.visits[0].residenceMs, null);
});

Deno.test("evidence remains cohort scoped with source pointers and unknown classifications", () => {
  const evidence = {
    workItem: "144",
    name: "shipping-run",
    stageId: "shipping",
    cycle: 1,
    payload: {
      status: "failed",
      runId: "run",
      outputs: { failureKind: "invented" },
    },
    source: journal[0].source,
  };
  const result = deliveryMetrics(
    ["144"],
    journal,
    [evidence, { ...evidence, workItem: "145" }],
    [],
  );
  equal(result.failures.length, 1);
  equal(result.failures[0].classification, "unknown");
  equal(result.failures[0].source, journal[0].source);
});
