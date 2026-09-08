import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../protocol/fixtures/snapshot.v1.json";
import deltaFixture from "../../../protocol/fixtures/delta-upsert.v1.json";
import heartbeat from "../../../protocol/fixtures/heartbeat.v1.json";
import provenance from "../../../protocol/fixtures/snapshot-provenance.v1.json";
import type {
  AgentStateEvent,
  AgentRecord,
} from "../../../protocol/generated/agent-state-event";
import { AgentStore, HISTORY_LIMIT } from "./store";
import { AgentWebSocketClient, type SocketLike } from "./ws-client";
import { decodeFeedEvent } from "./feed-decoder";

afterEach(() => vi.useRealTimers());
const upsert = (agent: AgentRecord): AgentStateEvent => ({
  version: 1,
  type: "delta",
  mode: "live",
  operation: "upsert",
  agent,
});
function connection() {
  vi.useFakeTimers();
  const store = new AgentStore();
  const sockets: SocketLike[] = [];
  const client = new AgentWebSocketClient("ws://test", store, () => {
    const socket: SocketLike = {
      readyState: 1,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close: vi.fn(),
    };
    sockets.push(socket);
    return socket;
  });
  client.start();
  sockets[0]!.onopen!();
  return { store, client, sockets };
}
it("closes silent opened sockets, ignores late callbacks, and cancels retries on stop", () => {
  const { client, sockets, store } = connection();
  const late = sockets[0]!.onmessage!;
  vi.advanceTimersByTime(2900);
  expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
  late({ data: JSON.stringify(fixture) });
  expect(store.snapshot().mode).toBe("disconnected");
  vi.advanceTimersByTime(1000);
  expect(sockets).toHaveLength(2);
  sockets[1]!.onerror!();
  client.stop();
  vi.advanceTimersByTime(10000);
  expect(sockets).toHaveLength(2);
  store.destroy();
});
it("bounds diagnostic samples without reading the stats panel", () => {
  const { client, sockets, store } = connection();
  for (let i = 0; i < 10000; i++) {
    sockets[0]!.onmessage!({ data: '{"version":1,"type":"heartbeat"}' });
    vi.advanceTimersByTime(100);
  }
  expect(client.diagnostics().retainedByteBuckets).toBeLessThanOrEqual(10);
  client.stop();
  store.destroy();
});
it("reconnects rejected state, reports repeated failure, and recovers on snapshot", () => {
  const { client, sockets, store } = connection();
  sockets[0]!.onmessage!({ data: JSON.stringify(fixture) });
  const rejectedUpdate = {
    ...deltaFixture,
    agent: { ...deltaFixture.agent, name: "x".repeat(4097) },
  };
  const oldMessage = sockets[0]!.onmessage!;
  oldMessage({ data: JSON.stringify(rejectedUpdate) });
  oldMessage({ data: JSON.stringify(heartbeat) });
  oldMessage({ data: JSON.stringify(deltaFixture) });
  expect(store.snapshot().agents.get("agent-01")?.targetState).toBe("working");
  expect(store.snapshot()).toMatchObject({
    mode: "disconnected",
    disconnectReason: null,
  });
  expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
  expect(client.diagnostics().invalidMessages).toBe(1);

  vi.advanceTimersByTime(1000);
  expect(sockets).toHaveLength(2);
  sockets[1]!.onopen!();
  sockets[1]!.onmessage!({ data: JSON.stringify(rejectedUpdate) });
  expect(store.snapshot()).toMatchObject({
    mode: "disconnected",
    disconnectReason: "incompatibleFeed",
  });
  expect(client.diagnostics().invalidMessages).toBe(2);

  vi.advanceTimersByTime(1000);
  sockets[2]!.onopen!();
  sockets[2]!.onmessage!({ data: JSON.stringify(fixture) });
  expect(store.snapshot().agents.size).toBe(fixture.agents.length);
  expect(store.snapshot()).toMatchObject({
    mode: "live",
    disconnectReason: null,
  });
  client.stop();
  store.destroy();
});
it("bounds the snapshot wait despite heartbeats and deltas", () => {
  const { client, sockets, store } = connection();
  vi.advanceTimersByTime(2800);
  sockets[0]!.onmessage!({ data: JSON.stringify(heartbeat) });
  sockets[0]!.onmessage!({ data: JSON.stringify(deltaFixture) });
  vi.advanceTimersByTime(100);
  expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
  expect(store.snapshot().agents.size).toBe(0);
  client.stop();
  store.destroy();
});
it("rejects unsupported events without partial mutation", () => {
  const { client, sockets, store } = connection();
  sockets[0]!.onmessage!({ data: JSON.stringify(fixture) });
  const before = store.snapshot().agents;
  sockets[0]!.onmessage!({
    data: JSON.stringify({
      version: 1,
      type: "snapshot-v2",
      agents: [{ ...fixture.agents[0], state: "blocked" }],
    }),
  });
  expect(store.snapshot().agents).toBe(before);
  expect(store.snapshot().mode).toBe("disconnected");
  expect(client.diagnostics().invalidMessages).toBe(1);
  client.stop();
  store.destroy();
});
it("resets demo history on live recovery but retains same-mode live history", () => {
  const { client, sockets, store } = connection();
  const send = (event: unknown) =>
    sockets[0]!.onmessage!({ data: JSON.stringify(event) });
  send({ ...fixture, mode: "demo" });
  send({
    ...upsert({ ...fixture.agents[0], state: "blocked" } as AgentRecord),
    mode: "demo",
  });
  send({
    ...upsert({ ...fixture.agents[1], state: "ended" } as AgentRecord),
    mode: "demo",
  });
  store.select("agent-02");
  expect(store.snapshot().board.map(({ id }) => id)).toEqual(["agent-02"]);
  expect(store.snapshot().agents.get("agent-01")!.history).toHaveLength(2);

  send(fixture);
  expect([...store.snapshot().agents.keys()]).toEqual(["agent-01", "agent-02"]);
  expect(store.snapshot().agents.get("agent-01")!.history).toHaveLength(1);
  expect(store.snapshot().board).toEqual([]);
  expect(store.snapshot().selectedId).toBeNull();

  send(upsert({ ...fixture.agents[1], state: "ended" } as AgentRecord));
  send(fixture);
  expect(store.snapshot().board.map(({ id }) => id)).toEqual(["agent-02"]);
  expect(store.snapshot().agents.get("agent-01")!.history).toHaveLength(1);
  client.stop();
  store.destroy();
});
it("validates complete event shapes", () => {
  expect(decodeFeedEvent(JSON.stringify(fixture)).kind).toBe("accepted");
  for (const value of [
    null,
    { version: 1, type: "delta", mode: "live", operation: "other" },
    { ...fixture, agents: [fixture.agents[0], fixture.agents[0]] },
    { ...fixture, agents: [{ ...fixture.agents[0], session: null }] },
    { ...fixture, sourceStatus: "invented" },
    { version: 2, type: "future-state" },
  ])
    expect(decodeFeedEvent(JSON.stringify(value)).kind).not.toBe("accepted");
});
it("preserves explicit unknown and genuine zero from the shared protocol fixture", () => {
  const outcome = decodeFeedEvent(JSON.stringify(provenance));
  expect(outcome).toEqual({ kind: "accepted", event: provenance });
  const store = new AgentStore();
  if (outcome.kind !== "accepted") throw new Error("fixture was rejected");
  store.apply(outcome.event);
  expect(store.snapshot().agents.get("fictional-unknown")).toMatchObject({
    stateKnown: false,
    session: { ticketsAvailable: false },
  });
  expect(store.snapshot().agents.get("fictional-zero")).toMatchObject({
    stateKnown: true,
    session: { tickets: 0, ticketsAvailable: true },
  });
  for (const value of [
    { ...provenance, extra: true },
    {
      ...provenance,
      agents: [{ ...provenance.agents[0], stateKnown: "false" }],
    },
    {
      ...provenance,
      agents: [
        {
          ...provenance.agents[0],
          session: { runtimeMs: 0, tickets: 0, ticketsAvailable: "yes" },
        },
      ],
    },
  ])
    expect(decodeFeedEvent(JSON.stringify(value)).kind).toBe("rejected");
  store.destroy();
});
it("notifies all subscribers on expiry and preserves dismissal until state reentry", () => {
  vi.useFakeTimers();
  const store = new AgentStore(undefined, { doneTimeoutMs: 10 });
  const agent = { ...fixture.agents[0], state: "done" } as AgentRecord;
  store.apply({ ...fixture, agents: [agent] } as AgentStateEvent);
  store.select(agent.id);
  const changed = vi.fn(),
    coarse = vi.fn();
  store.subscribe(changed);
  store.subscribeCoarse(coarse);
  vi.advanceTimersByTime(10);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(coarse).toHaveBeenCalledTimes(1);
  expect(store.coarse()).toMatchObject({
    sourceCount: 1,
    visibleCount: 0,
    clearedCount: 1,
    mode: "live",
    selectedId: null,
  });
  store.apply(upsert(agent));
  expect(store.coarse().visibleCount).toBe(0);
  store.apply(upsert({ ...agent, state: "working" }));
  expect(store.coarse()).toMatchObject({ visibleCount: 1, clearedCount: 0 });
  store.destroy();
});
it("keeps a fixture-backed done cook visible until its newest reconnect generation expires", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const decodedSnapshot = (stateEnteredAt: string) => {
      const outcome = decodeFeedEvent(
        JSON.stringify({
          ...fixture,
          agents: fixture.agents.map((agent) =>
            agent.id === "agent-01"
              ? { ...agent, state: "done", stateEnteredAt }
              : agent,
          ),
        }),
      );
      if (outcome.kind !== "accepted") throw new Error("fixture was rejected");
      return outcome.event;
    },
    store = new AgentStore(undefined, { doneTimeoutMs: 300_000 }),
    events: string[] = [],
    visibility: boolean[] = [];
  store.onEvent((event) => events.push(event.type));
  store.subscribe(() =>
    visibility.push(store.snapshot().visibleAgents.has("agent-01")),
  );

  const first = decodedSnapshot("2026-07-31T16:01:00Z");
  store.apply(first);
  expect(store.snapshot().agents.get("agent-01")?.clearAt).toBe(300_000);
  vi.advanceTimersByTime(240_000);
  store.setDisconnected();
  store.apply(decodedSnapshot("2026-07-31T16:00:00Z"));
  expect(store.snapshot().agents.get("agent-01")).toMatchObject({
    stateEnteredAt: "2026-07-31T16:00:00Z",
    clearAt: 300_000,
  });
  store.apply(decodedSnapshot("2026-07-31T16:01:00Z"));
  expect(store.snapshot().agents.get("agent-01")?.clearAt).toBe(300_000);
  store.apply(decodedSnapshot("2026-07-31T16:02:00Z"));
  expect(store.snapshot().agents.get("agent-01")?.clearAt).toBe(540_000);

  vi.advanceTimersByTime(60_000);
  expect(store.snapshot().agents.has("agent-01")).toBe(true);
  expect(events).not.toContain("clear");
  expect(visibility).not.toContain(false);
  vi.advanceTimersByTime(240_000);
  expect(events.filter((event) => event === "busser")).toHaveLength(1);
  expect(events.filter((event) => event === "clear")).toHaveLength(1);
  expect(visibility.filter((visible) => !visible)).toHaveLength(1);
  store.destroy();
});
it("updates authoritative data without resurrecting an expired done generation", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const decodedSnapshot = (stateEnteredAt: string, name?: string) => {
      const outcome = decodeFeedEvent(
        JSON.stringify({
          ...fixture,
          agents: fixture.agents
            .filter((agent) => agent.id === "agent-01")
            .map((agent) => ({
              ...agent,
              name: name ?? agent.name,
              state: "done",
              stateEnteredAt,
            })),
        }),
      );
      if (outcome.kind !== "accepted") throw new Error("fixture was rejected");
      return outcome.event;
    },
    store = new AgentStore(undefined, { doneTimeoutMs: 300_000 }),
    events: string[] = [];
  store.onEvent((event) => events.push(event.type));

  store.apply(decodedSnapshot("2026-07-31T16:01:00Z"));
  vi.advanceTimersByTime(300_000);
  store.apply(decodedSnapshot("2026-07-31T16:00:00Z"));
  store.apply(decodedSnapshot("2026-07-31T16:01:00Z", "Updated example cook"));
  expect(store.snapshot().agents.get("agent-01")?.name).toBe(
    "Updated example cook",
  );
  expect(store.snapshot().visibleAgents.has("agent-01")).toBe(false);
  store.revealCleared();
  expect(store.snapshot().visibleAgents.get("agent-01")?.name).toBe(
    "Updated example cook",
  );
  store.apply(decodedSnapshot("2026-07-31T16:01:00Z"));
  expect(store.snapshot().agents.has("agent-01")).toBe(true);
  expect(store.snapshot().visibleAgents.has("agent-01")).toBe(true);

  store.apply(decodedSnapshot("2026-07-31T16:02:00Z"));
  expect(store.snapshot().agents.get("agent-01")).toMatchObject({
    stateEnteredAt: "2026-07-31T16:02:00Z",
    clearAt: 600_000,
  });
  vi.advanceTimersByTime(300_000);
  expect(events.filter((event) => event === "busser")).toHaveLength(2);
  expect(events.filter((event) => event === "clear")).toHaveLength(2);
  store.destroy();
});
it("retains only recent history under sustained state churn", () => {
  const store = new AgentStore();
  for (let i = 0; i < 10000; i++)
    store.apply(
      upsert({
        ...fixture.agents[0],
        state: i % 2 ? "idle" : "working",
        stateEnteredAt: new Date(i * 2000).toISOString(),
      } as AgentRecord),
    );
  expect(
    store.snapshot().agents.get(fixture.agents[0]!.id)!.history,
  ).toHaveLength(HISTORY_LIMIT);
  store.destroy();
});
