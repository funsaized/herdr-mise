import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStateEvent } from "../../../protocol/generated/agent-state-event";
import fixture from "../../../protocol/fixtures/snapshot.v1.json";
import { AgentStore, type Scheduler } from "../state/store";
import { StateAnnouncementController } from "./state-announcements";

const snapshot = fixture as Extract<AgentStateEvent, { type: "snapshot" }>;

function scheduler(): Scheduler {
  return {
    now: Date.now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
}

afterEach(() => vi.useRealTimers());

describe("state announcements", () => {
  it("preserves single-transition wording and cancels pending work on destroy", () => {
    vi.useFakeTimers();
    const clock = scheduler(),
      store = new AgentStore(clock),
      announce = vi.fn(),
      controller = new StateAnnouncementController(store, announce, clock);
    store.apply(snapshot);
    store.apply({
      ...snapshot,
      agents: [
        { ...snapshot.agents[0]!, state: "blocked", progress: null },
        snapshot.agents[1]!,
      ],
    });
    vi.advanceTimersByTime(100);
    expect(announce).toHaveBeenCalledWith("refactor-agent blocked, just now");

    store.apply(snapshot);
    controller.destroy();
    vi.advanceTimersByTime(100);
    expect(announce).toHaveBeenCalledOnce();
    store.destroy();
  });

  it("prioritizes both fixture identities in one blocked burst summary", () => {
    vi.useFakeTimers();
    const clock = scheduler(),
      store = new AgentStore(clock),
      third = {
        ...snapshot.agents[0]!,
        id: "agent-03",
        name: "build-agent",
        state: "idle" as const,
        progress: null,
      },
      announce = vi.fn(),
      controller = new StateAnnouncementController(store, announce, clock);
    store.apply({ ...snapshot, agents: [...snapshot.agents, third] });

    store.apply({
      ...snapshot,
      agents: [
        { ...snapshot.agents[0]!, state: "blocked", progress: null },
        { ...snapshot.agents[1]!, state: "blocked", progress: null },
        { ...third, state: "working", progress: 0.5 },
      ],
    });
    expect(announce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);

    expect(announce).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledWith(
      "2 agents blocked: refactor-agent and review-agent. Use Agent stations to open details.",
    );
    controller.destroy();
    store.destroy();
  });

  it("disambiguates a single blocked transition like semantic station controls", () => {
    vi.useFakeTimers();
    const clock = scheduler(),
      store = new AgentStore(clock),
      duplicate = {
        ...snapshot.agents[0]!,
        id: "agent-02",
        paneId: "pane-02",
      },
      agents = [snapshot.agents[0]!, duplicate],
      announce = vi.fn(),
      controller = new StateAnnouncementController(store, announce, clock);
    store.apply({ ...snapshot, agents });
    store.apply({
      ...snapshot,
      agents: [
        { ...agents[0]!, state: "blocked" as const, progress: null },
        agents[1]!,
      ],
    });
    vi.advanceTimersByTime(100);

    expect(announce).toHaveBeenCalledWith(
      "refactor-agent · refactor · pane-01 blocked, just now",
    );
    controller.destroy();
    store.destroy();
  });

  it("keeps bounded blocked identities distinct when long locators differ", () => {
    vi.useFakeTimers();
    const clock = scheduler(),
      store = new AgentStore(clock),
      agents = ["one", "two"].map((middle, index) => ({
        ...snapshot.agents[0]!,
        id: `agent-${index}`,
        paneId: `pane-${"x".repeat(30)}${middle}${"y".repeat(30)}-end`,
      })),
      announce = vi.fn(),
      controller = new StateAnnouncementController(store, announce, clock);
    store.apply({ ...snapshot, agents });
    store.apply({
      ...snapshot,
      agents: agents.map((agent) => ({
        ...agent,
        state: "blocked" as const,
        progress: null,
      })),
    });
    vi.advanceTimersByTime(100);

    const message = announce.mock.lastCall?.[0];
    expect(message).toContain("agent 1 and");
    expect(message).toContain("agent 2");
    expect(message?.length).toBeLessThan(160);
    controller.destroy();
    store.destroy();
  });

  it("caps excess identities and directs listeners to Agent stations", () => {
    vi.useFakeTimers();
    const clock = scheduler(),
      store = new AgentStore(clock),
      initial = Array.from({ length: 5 }, (_, index) => ({
        ...snapshot.agents[0]!,
        id: `agent-${index}`,
        name: `${index}-${"x".repeat(60)}`,
      })),
      announce = vi.fn(),
      controller = new StateAnnouncementController(store, announce, clock);
    store.apply({ ...snapshot, agents: initial });
    store.apply({
      ...snapshot,
      agents: initial.map((agent) => ({
        ...agent,
        state: "blocked" as const,
        progress: null,
      })),
    });
    vi.advanceTimersByTime(100);

    const message = announce.mock.lastCall?.[0];
    expect(message).toContain("5 agents blocked:");
    expect(message).toContain("and 3 more");
    expect(message).toContain("Use Agent stations to open details.");
    expect(message).not.toContain(initial[2]!.name);
    expect(message?.length).toBeLessThan(160);
    controller.destroy();
    store.destroy();
  });

  it("ignores heartbeats, progress-only updates, and repeated states", () => {
    vi.useFakeTimers();
    const clock = scheduler(),
      store = new AgentStore(clock),
      announce = vi.fn(),
      controller = new StateAnnouncementController(store, announce, clock);
    store.apply(snapshot);
    store.apply({ version: 1, type: "heartbeat" });
    store.apply({
      version: 1,
      type: "delta",
      mode: "live",
      operation: "upsert",
      agent: { ...snapshot.agents[0]!, progress: 0.9 },
    });
    store.apply(snapshot);
    vi.advanceTimersByTime(1_000);

    expect(announce).not.toHaveBeenCalled();
    controller.destroy();
    store.destroy();
  });
});
