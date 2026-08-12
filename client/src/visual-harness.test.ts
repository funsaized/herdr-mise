import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "./state/store";
import { AgentWebSocketClient } from "./state/ws-client";
import {
  createHintPersistence,
  createReducedMotionPreference,
  createRuntimeStore,
} from "./runtime";
import {
  buildVisualFeed,
  initializeVisualMode,
  installVisualWebSocket,
  isVisualMode,
  parseVisualConfig,
} from "./visual-harness";
import { stationIdentityLabels } from "./scene/kitchen-scene";

afterEach(() => vi.useRealTimers());

it("tracks reduced-motion changes in both directions and cleans up its media-query listener", () => {
  let matches = true;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return matches;
    },
    addEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
    ),
    removeEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
    ),
  } as unknown as MediaQueryList;
  const preference = createReducedMotionPreference(query),
    changes: boolean[] = [];
  expect(preference.current()).toBe(true);
  const unsubscribe = preference.subscribe((value) => changes.push(value));
  matches = false;
  for (const listener of listeners)
    listener({ matches } as MediaQueryListEvent);
  matches = true;
  for (const listener of listeners)
    listener({ matches } as MediaQueryListEvent);
  expect(changes).toEqual([false, true]);
  unsubscribe();
  expect(query.removeEventListener).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
});

describe("visual harness configuration", () => {
  it("parses every supported scene control", () => {
    expect(parseVisualConfig("?preset=done&agents=2&theme=dinner")).toEqual({
      preset: "done",
      agents: 2,
      theme: "dark",
    });
    expect(parseVisualConfig("?preset=mixed&agents=12&theme=light")).toEqual({
      preset: "mixed",
      agents: 12,
      theme: "light",
    });
    for (let agents = 1; agents <= 12; agents += 1) {
      expect(parseVisualConfig(`?agents=${agents}`).agents).toBe(agents);
    }
  });

  it("uses deterministic defaults for absent and unsupported values", () => {
    const fallback = { preset: "mixed", agents: 6, theme: "light" };
    expect(parseVisualConfig("")).toEqual(fallback);
    for (const agents of ["nope", "1.5", "Infinity", "0", "13"]) {
      expect(parseVisualConfig(`?preset=nope&agents=${agents}`)).toEqual(
        fallback,
      );
    }
  });

  it("generates feeds matching intermediate agent counts", () => {
    for (const agents of [3, 4, 5, 7, 11] as const) {
      const [event] = buildVisualFeed({
        preset: "mixed",
        agents,
        theme: "light",
      });
      expect(event?.type).toBe("snapshot");
      if (event?.type === "snapshot") expect(event.agents).toHaveLength(agents);
    }
  });

  it("constructs stable protocol feeds for all supported counts and active presets", () => {
    for (const agents of [1, 2, 6, 12] as const)
      for (const preset of ["idle", "working", "blocked", "done"] as const) {
        const feed = buildVisualFeed({ preset, agents, theme: "light" });
        expect(feed).toHaveLength(1);
        expect(feed[0]).toMatchObject({
          version: 1,
          type: "snapshot",
          mode: "demo",
        });
        if (feed[0]?.type === "snapshot") {
          expect(feed[0].agents).toHaveLength(agents);
          expect(feed[0].agents.every((agent) => agent.state === preset)).toBe(
            true,
          );
          expect(feed[0].agents.map((agent) => agent.progress)).toEqual(
            preset === "working"
              ? Array.from({ length: agents }, (_, index) => (index + 1) / 13)
              : Array(agents).fill(null),
          );
        }
      }
  });

  it("keeps every emitted progress value within protocol bounds", () => {
    for (const agents of [1, 2, 6, 12] as const)
      for (const preset of [
        "idle",
        "working",
        "blocked",
        "done",
        "ended",
        "mixed",
      ] as const) {
        for (const event of buildVisualFeed({
          preset,
          agents,
          theme: "light",
        })) {
          const records =
            event.type === "snapshot"
              ? event.agents
              : event.type === "delta" && event.operation === "upsert"
                ? [event.agent]
                : [];
          expect(
            records.every(
              (agent) =>
                agent.progress === null ||
                (agent.progress >= 0 && agent.progress <= 1),
            ),
          ).toBe(true);
        }
      }
  });

  it("builds an inspectable mixed service without changing existing counts", () => {
    const now = Date.parse("2026-08-01T15:00:00.000Z");
    const [event] = buildVisualFeed(
      { preset: "mixed", agents: 6, theme: "light" },
      now,
    );
    expect(event?.type).toBe("snapshot");
    if (event?.type !== "snapshot") return;
    expect(event.agents).toHaveLength(6);
    expect(
      new Set(event.agents.map((agent) => agent.state)).size,
    ).toBeGreaterThanOrEqual(3);
    expect(
      event.agents.some(
        (agent, index) =>
          event.agents.findIndex((other) => other.state === agent.state) !==
          index,
      ),
    ).toBe(true);
    expect(
      new Set(event.agents.map((agent) => agent.model)).size,
    ).toBeGreaterThanOrEqual(4);
    expect(new Set(event.agents.map((agent) => agent.workspace)).size).toBe(6);
    expect(new Set(event.agents.map((agent) => agent.accentIndex)).size).toBe(
      6,
    );
    expect(
      event.agents.some(
        (agent) =>
          agent.state === "blocked" &&
          now - Date.parse(agent.stateEnteredAt) >= 45_000,
      ),
    ).toBe(true);
  });

  it("keeps all twelve mixed visible identities and workspaces unique", () => {
    const [event] = buildVisualFeed({
      preset: "mixed",
      agents: 12,
      theme: "light",
    });
    expect(event?.type).toBe("snapshot");
    if (event?.type !== "snapshot") return;
    expect(
      new Set(event.agents.map((agent) => `${agent.name}:${agent.workspace}`)),
    ).toHaveLength(12);
    expect(new Set(event.agents.map((agent) => agent.workspace))).toHaveLength(
      12,
    );
  });

  it("anchors every preset's active record at a deterministic recent age", () => {
    const now = Date.parse("2026-08-01T15:00:00.000Z");
    const expected = {
      idle: 12_000,
      working: 18_000,
      blocked: 45_000,
      done: 8_000,
      ended: 8_000,
    } as const;
    for (const preset of [
      "idle",
      "working",
      "blocked",
      "done",
      "ended",
    ] as const) {
      const [event] = buildVisualFeed(
        { preset, agents: 1, theme: "light" },
        now,
      );
      expect(event?.type).toBe("snapshot");
      if (event?.type === "snapshot")
        expect(now - Date.parse(event.agents[0]!.stateEnteredAt)).toBe(
          expected[preset],
        );
    }
  });

  it("models ended through prior active truth and ended deltas", () => {
    const store = new AgentStore();
    for (const event of buildVisualFeed({
      preset: "ended",
      agents: 2,
      theme: "light",
    }))
      store.apply(event);
    expect(store.snapshot().agents.size).toBe(0);
    expect(store.snapshot().board).toHaveLength(2);
    expect(
      store.snapshot().board.every((entry) => entry.finalState === "done"),
    ).toBe(true);
  });
});

describe("visual WebSocket boundary", () => {
  it("moves the mixed-feed hero through working, blocked, answered, working, and done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-01T15:00:00.000Z"));
    const target = {} as { WebSocket?: typeof WebSocket };
    installVisualWebSocket(target, {
      preset: "mixed",
      agents: 6,
      theme: "light",
    });
    const socket = new target.WebSocket!("ws://visual/ws");
    const messages: unknown[] = [];
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    await vi.runAllTicks();
    const heroEvents = () =>
      messages.flatMap((event) => {
        if (!event || typeof event !== "object") return [];
        const message = event as {
          type?: string;
          agents?: Array<{ id: string; state: string }>;
          agent?: { id: string; state: string };
        };
        if (message.type === "snapshot")
          return (
            message.agents
              ?.filter((agent) => agent.id === "visual-agent-1")
              .map((agent) => agent.state) ?? []
          );
        return message.agent?.id === "visual-agent-1"
          ? [message.agent.state]
          : [];
      });
    expect(heroEvents()).toEqual(["working"]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(heroEvents()).toEqual(["working"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(heroEvents()).toEqual(["working", "blocked"]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(heroEvents()).toEqual(["working", "blocked"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(heroEvents()).toEqual(["working", "blocked", "working"]);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(heroEvents()).toEqual(["working", "blocked", "working"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(heroEvents()).toEqual(["working", "blocked", "working", "done"]);
    const heroRecords = messages.flatMap((event) => {
      if (!event || typeof event !== "object") return [];
      const message = event as {
        type?: string;
        agents?: Array<{ id: string; name: string; accentIndex: number }>;
        agent?: { id: string; name: string; accentIndex: number };
      };
      if (message.type === "snapshot")
        return (
          message.agents?.filter((agent) => agent.id === "visual-agent-1") ?? []
        );
      return message.agent?.id === "visual-agent-1" ? [message.agent] : [];
    });
    expect(heroRecords).toHaveLength(4);
    expect(
      heroRecords.every(
        (record) =>
          record.id === "visual-agent-1" &&
          record.name === "Codex" &&
          record.accentIndex === 0,
      ),
    ).toBe(true);
    socket.close();
  });

  it("shows a generic temporary answer cue only after blocked returns to working", () => {
    const now = Date.parse("2026-08-01T15:00:00.000Z"),
      store = new AgentStore({ now: () => now, setTimeout, clearTimeout });
    const hero = (state: "blocked" | "working") => ({
      version: 1 as const,
      type: "delta" as const,
      mode: "demo" as const,
      operation: "upsert" as const,
      agent: {
        id: "hero",
        name: "Any agent",
        state,
        progress: state === "working" ? 0.7 : null,
        stateEnteredAt: new Date(now).toISOString(),
        accentIndex: 0,
        model: "codex",
        workspace: "/work/any",
        session: { runtimeMs: 1, tickets: 0 },
      },
    });
    store.apply({
      version: 1,
      type: "snapshot",
      mode: "demo",
      sourceStatus: "unavailableSocket",
      agents: [hero("blocked").agent],
    });
    store.apply(hero("working"));
    const agent = store.snapshot().agents.get("hero")!;
    expect(stationIdentityLabels(agent, "working", now).status).toContain(
      "ANSWER RECEIVED",
    );
    expect(
      stationIdentityLabels(agent, "working", now + 2_001).status,
    ).toContain("FIRE");
  });

  it("does not show the answer cue for initial working or idle returning to working", () => {
    const now = Date.parse("2026-08-01T15:00:00.000Z"),
      store = new AgentStore({ now: () => now, setTimeout, clearTimeout });
    const record = (state: "idle" | "working") => ({
      id: "hero",
      name: "Any agent",
      state,
      progress: state === "working" ? 0.7 : null,
      stateEnteredAt: new Date(now).toISOString(),
      accentIndex: 0,
      model: "codex",
      workspace: "/work/any",
      session: { runtimeMs: 1, tickets: 0 },
    });
    store.apply({
      version: 1,
      type: "snapshot",
      mode: "demo",
      sourceStatus: "unavailableSocket",
      agents: [record("working")],
    });
    expect(
      stationIdentityLabels(
        store.snapshot().agents.get("hero")!,
        "working",
        now,
      ).status,
    ).toContain("FIRE");
    store.apply({
      version: 1,
      type: "delta",
      mode: "demo",
      operation: "upsert",
      agent: record("idle"),
    });
    store.apply({
      version: 1,
      type: "delta",
      mode: "demo",
      operation: "upsert",
      agent: record("working"),
    });
    expect(
      stationIdentityLabels(
        store.snapshot().agents.get("hero")!,
        "working",
        now,
      ).status,
    ).toContain("FIRE");
  });

  it("delivers the deterministic feed through AgentWebSocketClient", async () => {
    const target = {} as { WebSocket?: typeof WebSocket };
    installVisualWebSocket(target, {
      preset: "blocked",
      agents: 2,
      theme: "light",
    });
    const store = new AgentStore();
    const client = new AgentWebSocketClient(
      "ws://visual/ws",
      store,
      (url) => new target.WebSocket!(url) as never,
    );
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.snapshot().mode).toBe("demo");
    expect(
      [...store.snapshot().agents.values()].map((agent) => agent.state),
    ).toEqual(["blocked", "blocked"]);
    client.stop();
  });

  it("delegates every socket except the application /ws endpoint", () => {
    const nativeSocket = { readyState: WebSocket.CONNECTING };
    const Native = vi.fn(function () {
      return nativeSocket;
    }) as unknown as typeof WebSocket;
    const target = { WebSocket: Native };
    installVisualWebSocket(target, {
      preset: "working",
      agents: 1,
      theme: "light",
    });
    const Installed = target.WebSocket!;
    expect(new Installed("ws://localhost:5173/@vite/client")).toBe(
      nativeSocket,
    );
    expect(new Installed("ws://localhost:5173/other")).toBe(nativeSocket);
    expect(Native).toHaveBeenCalledTimes(2);
    expect(new Installed("ws://localhost:5173/ws")).not.toBe(nativeSocket);
    expect(Native).toHaveBeenCalledTimes(2);
  });

  it("stays live beyond the stale window and releases heartbeat timers on close", async () => {
    vi.useFakeTimers();
    const target = {} as { WebSocket?: typeof WebSocket };
    installVisualWebSocket(target, {
      preset: "working",
      agents: 1,
      theme: "light",
    });
    const store = new AgentStore(),
      disconnected = vi.spyOn(store, "setDisconnected"),
      client = new AgentWebSocketClient(
        "ws://visual/ws",
        store,
        (url) => new target.WebSocket!(url) as never,
      );
    client.start();
    await vi.runAllTicks();
    expect(store.snapshot().mode).toBe("demo");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.snapshot().mode).toBe("demo");
    expect(disconnected).not.toHaveBeenCalled();
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels every mixed lifecycle timer when the socket closes", async () => {
    vi.useFakeTimers();
    const target = {} as { WebSocket?: typeof WebSocket };
    installVisualWebSocket(target, {
      preset: "mixed",
      agents: 6,
      theme: "light",
    });
    const socket = new target.WebSocket!("ws://visual/ws");
    await vi.runAllTicks();
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    socket.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can close while CONNECTING without opening or leaking timers", async () => {
    vi.useFakeTimers();
    const target = {} as { WebSocket?: typeof WebSocket };
    installVisualWebSocket(target, {
      preset: "working",
      agents: 1,
      theme: "light",
    });
    const socket = new target.WebSocket!("ws://visual/ws");
    const opened = vi.fn(),
      messaged = vi.fn();
    socket.onopen = opened;
    socket.onmessage = messaged;
    socket.close();
    await vi.runAllTicks();
    expect(opened).not.toHaveBeenCalled();
    expect(messaged).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("only identifies the explicit Vite visual mode", () => {
    expect(isVisualMode("visual")).toBe(true);
    expect(isVisualMode("development")).toBe(false);
    expect(isVisualMode("production")).toBe(false);
  });

  it("isolates visual settings from persisted production settings", () => {
    const storage = {
      getItem: vi.fn(() =>
        JSON.stringify({ version: 1, settings: { theme: "dark" } }),
      ),
      setItem: vi.fn(),
    };
    const visual = createRuntimeStore("visual", "?theme=light", storage);
    expect(visual.snapshot().settings).toMatchObject({ theme: "light" });
    visual.setSettings({ theme: "dark" });
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    createRuntimeStore("production", "", storage);
    expect(storage.getItem).toHaveBeenCalledOnce();
  });

  it("uses the visible production done timeout without persisted settings", () => {
    vi.useFakeTimers();
    const visual = createRuntimeStore("visual", "?preset=done", null);
    for (const event of buildVisualFeed({
      preset: "done",
      agents: 1,
      theme: "light",
    }))
      visual.apply(event);
    expect(visual.snapshot().settings.doneTimeoutMs).toBe(600_000);
    vi.advanceTimersByTime(599_999);
    expect(visual.snapshot().agents.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(visual.snapshot().agents.size).toBe(0);
    visual.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes visual bell hints deterministic without touching production storage", () => {
    const storage = { getItem: vi.fn(() => "dismissed"), setItem: vi.fn() };
    const visual = createHintPersistence("visual", storage);
    expect(visual.isVisible()).toBe(true);
    visual.dismiss();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    const production = createHintPersistence("production", storage);
    expect(production.isVisible()).toBe(false);
    production.dismiss();
    expect(storage.getItem).toHaveBeenCalledOnce();
    expect(storage.setItem).toHaveBeenCalledWith("mise-bell-hint", "dismissed");
  });

  it("installs the mock only in visual startup mode", () => {
    const native = vi.fn() as unknown as typeof WebSocket,
      target = { WebSocket: native };
    expect(
      initializeVisualMode("production", target, "?preset=done"),
    ).toBeNull();
    expect(target.WebSocket).toBe(native);
    expect(initializeVisualMode("visual", target, "?preset=done")?.preset).toBe(
      "done",
    );
    expect(target.WebSocket).not.toBe(native);
  });
});
