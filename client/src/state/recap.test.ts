import { expect, it } from "vitest";
import type {
  AgentRecord,
  AgentStateEvent,
} from "../../../protocol/generated/agent-state-event";
import cases from "../../../server/tests/fixtures/service-recap-observations.json";
import { RECAP_LIMIT, ServiceRecap } from "./recap";

const agent = (
  id: string,
  state: AgentRecord["state"],
  generation: string,
  workspaceId: string | undefined = "one",
): AgentRecord => ({
  id,
  name: id,
  state,
  progress: null,
  stateEnteredAt: generation,
  workspaceId,
  workspace: workspaceId ?? "",
  accentIndex: 0,
  model: "",
  session: { runtimeMs: 999999, tickets: 0 },
});
const snap = (
  agents: AgentRecord[],
  sourceStatus: "connected" | "timeout" = "connected",
  mode: "live" | "demo" = "live",
): AgentStateEvent => ({
  type: "snapshot",
  version: 1,
  mode,
  sourceStatus,
  agents,
});

it("service recap excludes gaps and preserves retained outcomes", () => {
  const recap = new ServiceRecap();
  for (const step of cases.transitions)
    recap.apply(
      snap([
        agent(
          "a",
          step.state as AgentRecord["state"],
          step.generation,
          step.workspace,
        ),
      ]),
      step.at,
    );
  const result = recap.summary(null, 5000);
  expect([
    result.workingMs,
    result.blockedMs,
    result.medianWaitMs,
    result.blockedOccurrences,
    result.plated,
    result.ended,
  ]).toEqual([2000, 1000, 1000, 1, 1, 1]);
  recap.apply(
    snap([agent("a", "ended", cases.transitions[4].generation)]),
    6000,
  );
  expect(recap.summary(null, 6000).ended).toBe(1);
  recap.apply(
    snap([agent("b", "blocked", "2026-01-01T00:00:05Z", "two")]),
    6000,
  );
  recap.apply(
    snap([agent("b", "working", "2026-01-01T00:00:06Z", "two")]),
    8000,
  );
  expect(recap.summary(null, 8000).medianWaitMs).toBe(1500);
  expect(recap.summary(null, 8000).worstWaitMs).toBe(2000);
  const scoped = new ServiceRecap();
  scoped.apply(
    snap([agent("early", "working", "2026-01-01T00:00:00Z", "one")]),
    100,
  );
  scoped.apply(
    snap([
      agent("early", "working", "2026-01-01T00:00:00Z", "one"),
      agent("late", "blocked", "2026-01-01T00:00:00Z", "two"),
    ]),
    200,
  );
  expect(scoped.summary("two", 300).startedAt).toBe(200);
});
it("recap catalog lookup preserves renamed and removed workspace labels", () => {
  const recap = new ServiceRecap();
  let reads = 0;
  const catalog = Array.from({ length: RECAP_LIMIT }, (_, i) => ({
    id: `w${i}`,
    get label() {
      reads++;
      return `/kitchen/${i}/shared`;
    },
  }));
  const agents = catalog.map((w, i) =>
    agent(`a${i}`, "working", cases.transitions[0].generation, w.id),
  );
  recap.apply({ ...snap(agents), workspaces: catalog } as AgentStateEvent, 0);
  expect(reads).toBe(RECAP_LIMIT);
  expect(recap.summary(null, 1000).workspaces).toHaveLength(RECAP_LIMIT);
  expect(reads).toBe(RECAP_LIMIT);
  recap.apply(
    {
      ...snap([]),
      workspaces: [{ id: "w0", label: "/renamed/unique" }],
    } as AgentStateEvent,
    1000,
  );
  expect(recap.summary(null, 2000).workspaces.slice(0, 2)).toEqual([
    { id: "w0", label: "/renamed/unique" },
    { id: "w1", label: "/kitchen/1/shared" },
  ]);
  recap.apply(snap([]), 2000);
  expect(recap.summary(null, 2000).workspaces[0].label).toBe(
    "/kitchen/0/shared",
  );
  recap.apply(
    { ...snap([], "connected", "demo"), workspaces: [] } as AgentStateEvent,
    3000,
  );
  expect(recap.summary(null, 3000).workspaces).toEqual([]);
  expect(reads).toBe(RECAP_LIMIT);
});
it("service recap bounds retention across agent and workspace churn", () => {
  const recap = new ServiceRecap();
  recap.apply(snap([]), 0);
  for (let i = 0; i <= RECAP_LIMIT; i++) {
    recap.apply(
      snap([agent(`a${i}`, "blocked", "2026-01-01T00:00:00Z", `w${i}`)]),
      i * 3 + 1,
    );
    recap.apply(
      snap([agent(`a${i}`, "ended", "2026-01-01T00:00:01Z", `w${i}`)]),
      i * 3 + 2,
    );
  }
  const result = recap.summary(null, 20000);
  expect(result.truncated).toBe(true);
  expect(result.workspaces.length).toBeLessThanOrEqual(RECAP_LIMIT);
  expect(result.agents.length).toBeLessThanOrEqual(RECAP_LIMIT);
});
it("service recap updates same-state observations and resets between demo and live", () => {
  const recap = new ServiceRecap();
  recap.apply(snap([agent("a", "blocked", "2026-01-01T00:00:00Z")]), 100);
  recap.apply(snap([agent("a", "blocked", "2026-01-01T00:00:00Z")]), 200);
  expect(recap.summary(null, 200).blockedOccurrences).toBe(1);
  recap.apply(snap([agent("a", "blocked", "2026-01-01T00:00:01Z")]), 300);
  expect(recap.summary(null, 300).blockedOccurrences).toBe(2);
  recap.apply(snap([], "timeout", "demo"), 400);
  expect(recap.summary(null, 400).blockedOccurrences).toBe(0);
  expect(recap.revision).toBeGreaterThan(1);
  recap.apply(
    snap([agent("a", "ended", "2026-01-01T00:00:02Z")], "timeout", "demo"),
    500,
  );
  recap.apply(
    snap([agent("a", "working", "2026-01-01T00:00:03Z")], "timeout", "demo"),
    600,
  );
  recap.apply(
    snap([agent("a", "ended", "2026-01-01T00:00:02Z")], "timeout", "demo"),
    700,
  );
  recap.apply(
    snap([agent("a", "ended", "2026-01-01T00:00:02Z")], "timeout", "demo"),
    800,
  );
  expect(recap.summary(null, 800).ended).toBe(2);
});
it("service recap excludes delayed source failure time despite heartbeats", () => {
  const recap = new ServiceRecap();
  const blocked = agent("a", "blocked", "2026-01-01T00:00:00Z");
  recap.apply(snap([blocked]), cases.delayedFailure.healthy);
  recap.apply(
    { type: "heartbeat", version: 1 },
    cases.delayedFailure.failedPolls[0],
  );
  recap.apply(snap([blocked], "timeout"), cases.delayedFailure.notification);
  expect(recap.summary(null, 4000).blockedMs).toBe(0);
  recap.apply(snap([blocked]), cases.delayedFailure.recovery);
  recap.apply(
    snap([agent("a", "working", "2026-01-01T00:00:02Z")]),
    cases.delayedFailure.finish,
  );
  expect(recap.summary(null, 8000).blockedMs).toBe(1000);
  expect(recap.summary(null, 8000).blockedOccurrences).toBe(1);
  expect(recap.summary(null, 8000).medianWaitMs).toBe(1000);
  const moved = new ServiceRecap();
  moved.apply(snap([agent("m", "blocked", "2026-01-01T00:00:00Z", "one")]), 0);
  moved.apply(
    snap([agent("m", "blocked", "2026-01-01T00:00:00Z", "two")]),
    1000,
  );
  moved.apply(
    snap([agent("m", "working", "2026-01-01T00:00:01Z", "two")]),
    3000,
  );
  expect(moved.summary(null, 3000).medianWaitMs).toBe(3000);
  expect(moved.summary("one", 3000).medianWaitMs).toBe(1000);
  expect(moved.summary("two", 3000).medianWaitMs).toBe(2000);
  expect(moved.summary(null, 3000).blockedOccurrences).toBe(1);
  moved.apply(snap([agent("m", "ended", "2026-01-01T00:00:02Z", "two")]), 4000);
  expect(moved.summary(null, 4000).partial).toBe(false);
  expect(moved.summary("one", 3000).partial).toBe(true);
  const collision = new ServiceRecap();
  const missing = agent("missing", "blocked", "2026-01-01T00:00:00Z");
  missing.workspaceId = undefined;
  collision.apply(
    snap([
      missing,
      agent("real", "working", "2026-01-01T00:00:00Z", "__missing__"),
    ]),
    100,
  );
  expect(collision.summary(null, 200).workspaces.map((w) => w.id)).toEqual([
    null,
    "__missing__",
  ]);
  expect(collision.summary(undefined, 200).agents.map((row) => row.id)).toEqual(
    ["missing"],
  );
  expect(
    collision.summary("__missing__", 200).agents.map((row) => row.id),
  ).toEqual(["real"]);
});
