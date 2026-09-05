import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../protocol/fixtures/snapshot.v1.json";
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
it("rejects a malformed snapshot atomically and keeps deltas locked", () => {
  const { client, sockets, store } = connection();
  const malformed = {
    ...fixture,
    agents: [fixture.agents[0], { id: "broken" }],
  };
  sockets[0]!.onmessage!({ data: JSON.stringify(malformed) });
  sockets[0]!.onmessage!({
    data: JSON.stringify(upsert(fixture.agents[0] as AgentRecord)),
  });
  expect(store.snapshot().agents.size).toBe(0);
  expect(client.diagnostics().invalidMessages).toBe(1);
  sockets[0]!.onmessage!({ data: JSON.stringify(fixture) });
  expect(store.snapshot().agents.size).toBe(fixture.agents.length);
  client.stop();
  store.destroy();
});
it("validates complete event shapes", () => {
  expect(decodeFeedEvent(JSON.stringify(fixture))).not.toBeNull();
  for (const value of [
    null,
    { version: 1, type: "delta", mode: "live", operation: "other" },
    { ...fixture, agents: [fixture.agents[0], fixture.agents[0]] },
    { ...fixture, agents: [{ ...fixture.agents[0], session: null }] },
    { ...fixture, sourceStatus: "invented" },
  ])
    expect(decodeFeedEvent(JSON.stringify(value))).toBeNull();
});
it("preserves explicit unknown and genuine zero from the shared protocol fixture", () => {
  const event = decodeFeedEvent(JSON.stringify(provenance));
  expect(event).toEqual(provenance);
  const store = new AgentStore();
  store.apply(event!);
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
    expect(decodeFeedEvent(JSON.stringify(value))).toBeNull();
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
    count: 0,
    mode: "empty",
    selectedId: null,
  });
  store.apply(upsert(agent));
  expect(store.coarse().count).toBe(0);
  store.apply(upsert({ ...agent, state: "working" }));
  expect(store.coarse().count).toBe(1);
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
