// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../protocol/fixtures/snapshot.v1.json";
import type { AgentStateEvent } from "../../../protocol/generated/agent-state-event";
import { AgentStore, type Scheduler } from "../state/store";
import { AgentWebSocketClient, type SocketLike } from "../state/ws-client";
import { OffscreenAttentionController } from "./offscreen-attention";
import { StateAnnouncementController } from "./state-announcements";

const initial = fixture as Extract<AgentStateEvent, { type: "snapshot" }>;
let hidden = false;
const deliveries = vi.fn();
const close = vi.fn();
const clock: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

function setup() {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      constructor(title: string, options: NotificationOptions) {
        deliveries(title, options.body);
      }
      close = close;
    },
  );
  const store = new AgentStore(clock, { desktopNotifications: true });
  const announce = vi.fn();
  const announcements = new StateAnnouncementController(
    store,
    announce,
    clock,
    (batch) => attention.deliver(batch),
  );
  const attention = new OffscreenAttentionController(
    store,
    announcements,
    clock,
  );
  const socket: SocketLike = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: vi.fn(),
  };
  const client = new AgentWebSocketClient(
    "ws://fixture",
    store,
    () => socket,
    clock,
  );
  client.start();
  socket.onopen?.();
  const heartbeat = setInterval(
    () =>
      socket.onmessage?.({
        data: JSON.stringify({ version: 1, type: "heartbeat" }),
      }),
    2_000,
  );
  const cleanup = () => {
    clearInterval(heartbeat);
    client.stop();
    attention.destroy();
    announcements.destroy();
    store.destroy();
  };
  const change = (agents: typeof initial.agents) =>
    socket.onmessage?.({ data: JSON.stringify({ ...initial, agents }) });
  const block = (
    agent = initial.agents[0]!,
    time = "2026-08-13T12:00:01Z",
  ) => ({
    ...agent,
    state: "blocked" as const,
    stateEnteredAt: time,
    progress: null,
  });
  const hide = (value: boolean) => {
    hidden = value;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { store, announce, change, block, hide, cleanup };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  deliveries.mockClear();
  close.mockClear();
});

it("projects global blocked attention without treating retained disconnected agents as live", () => {
  const original = document.title;
  const ctx = setup();
  ctx.change(initial.agents);
  ctx.store.selectWorkspace("other-workspace");
  ctx.change([
    ctx.block(),
    { ...initial.agents[1]!, stateKnown: false, state: "blocked" },
  ]);
  expect(document.title).toBe("(1 blocked) herdr-mise");
  const blockedIcon = document
    .querySelector('link[rel="icon"]')
    ?.getAttribute("href");
  ctx.store.setDisconnected();
  expect(document.title).toBe("Disconnected — herdr-mise");
  expect(
    document.querySelector('link[rel="icon"]')?.getAttribute("href"),
  ).not.toBe(blockedIcon);
  ctx.cleanup();
  expect(document.title).toBe(original);
});

it("coalesces hidden blocked transitions with existing state announcements", () => {
  const ctx = setup();
  ctx.change(initial.agents);
  ctx.hide(true);
  ctx.change([ctx.block(), ctx.block(initial.agents[1]!)]);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledOnce();
  expect(deliveries.mock.lastCall?.[1]).toContain("2 blocked agents");
  expect(ctx.announce).toHaveBeenCalledWith(
    expect.stringContaining("refactor-agent and review-agent"),
  );
  ctx.cleanup();
});

it("does not notify for foreground blocked transitions when hidden mid-burst", () => {
  const ctx = setup();
  ctx.change(initial.agents);
  ctx.change([ctx.block(), initial.agents[1]!]);
  ctx.hide(true);
  vi.advanceTimersByTime(100);
  expect(deliveries).not.toHaveBeenCalled();
  ctx.change(initial.agents);
  ctx.change([
    ctx.block(initial.agents[0]!, "2026-08-13T12:00:02Z"),
    initial.agents[1]!,
  ]);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledOnce();
  ctx.hide(false);
  ctx.change(initial.agents);
  ctx.hide(true);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledOnce();
  ctx.cleanup();
});

it("omits fixture identities and locators from desktop notification title and body", () => {
  const ctx = setup();
  const agents = initial.agents.map((agent, index) => ({
    ...agent,
    workspace: `/private/fixture-${index}`,
    paneId: `distinctive-pane-${index}`,
  }));
  ctx.change(agents);
  ctx.hide(true);
  ctx.change(agents.map((agent) => ctx.block(agent)));
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledOnce();
  const text = deliveries.mock.lastCall!.join(" ");
  for (const agent of agents)
    for (const identity of [agent.name, agent.workspace, agent.paneId])
      expect(text).not.toContain(identity);
  expect(ctx.announce.mock.lastCall?.[0]).toContain(agents[0]!.name);
  ctx.cleanup();
});

it("notifies once per blocked escalation without replaying delayed stages", () => {
  const ctx = setup();
  ctx.change(initial.agents);
  ctx.hide(true);
  ctx.change([ctx.block(), initial.agents[1]!]);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  vi.advanceTimersByTime(60_000);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledTimes(2);
  expect(deliveries.mock.lastCall?.[1]).toContain("escalated");
  vi.advanceTimersByTime(240_000);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledTimes(3);
  expect(deliveries.mock.lastCall?.[1]).toContain("screen-edge escalation");
  ctx.cleanup();
});

it("coalesces a late timer wakeup to the highest due escalation", () => {
  const ctx = setup();
  ctx.change(initial.agents);
  ctx.hide(true);
  ctx.change([ctx.block(), initial.agents[1]!]);
  vi.advanceTimersByTime(100);
  vi.setSystemTime(Date.now() + 360_000);
  vi.advanceTimersByTime(60_000);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledTimes(2);
  expect(deliveries.mock.lastCall?.[1]).toContain("screen-edge escalation");
  ctx.cleanup();
});

it("baselines initial and recovered snapshots without replaying blocked notifications", () => {
  const ctx = setup();
  ctx.hide(true);
  ctx.change([ctx.block(), initial.agents[1]!]);
  vi.advanceTimersByTime(100);
  expect(deliveries).not.toHaveBeenCalled();
  ctx.store.setDisconnected();
  ctx.change([ctx.block(), initial.agents[1]!]);
  vi.advanceTimersByTime(100);
  expect(deliveries).not.toHaveBeenCalled();
  ctx.cleanup();
});

it("recognizes new blocked episodes without notifying for repeated fixture updates", () => {
  const ctx = setup();
  ctx.change(initial.agents);
  ctx.hide(true);
  ctx.change([ctx.block(), initial.agents[1]!]);
  vi.advanceTimersByTime(100);
  ctx.change([ctx.block(), initial.agents[1]!]);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledOnce();
  ctx.change([
    ctx.block(initial.agents[0]!, "2026-08-13T12:00:02Z"),
    initial.agents[1]!,
  ]);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledTimes(2);
  ctx.change([
    ctx.block(initial.agents[0]!, "2026-08-13T12:00:02Z"),
    ctx.block(initial.agents[1]!),
  ]);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledTimes(3);
  ctx.cleanup();
});

it("delivers desktop-only new and same-state episodes without extra accessibility announcements", () => {
  const ctx = setup();
  const added = {
    ...ctx.block(initial.agents[1]!),
    id: "new-blocked-agent",
  };
  ctx.change([ctx.block(), initial.agents[1]!]);
  ctx.hide(true);
  ctx.change([ctx.block(), initial.agents[1]!, added]);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledOnce();
  expect(ctx.announce).not.toHaveBeenCalled();
  ctx.change([
    ctx.block(initial.agents[0]!, "2026-08-13T12:00:02Z"),
    initial.agents[1]!,
    added,
  ]);
  vi.advanceTimersByTime(100);
  expect(deliveries).toHaveBeenCalledTimes(2);
  expect(ctx.announce).not.toHaveBeenCalled();
  ctx.cleanup();
});

it("cancels pending delivery on foregrounding, resolution, disabling and permission loss", () => {
  const ctx = setup();
  ctx.change(initial.agents);
  ctx.hide(true);
  ctx.change([ctx.block(), initial.agents[1]!]);
  ctx.hide(false);
  vi.advanceTimersByTime(100);
  expect(deliveries).not.toHaveBeenCalled();
  ctx.hide(true);
  ctx.change(initial.agents);
  ctx.change([
    ctx.block(initial.agents[0]!, "2026-08-13T12:00:02Z"),
    initial.agents[1]!,
  ]);
  ctx.change(initial.agents);
  vi.advanceTimersByTime(100);
  expect(deliveries).not.toHaveBeenCalled();
  ctx.change([
    ctx.block(initial.agents[0]!, "2026-08-13T12:00:03Z"),
    initial.agents[1]!,
  ]);
  ctx.store.setSettings({ desktopNotifications: false });
  ctx.store.setSettings({ desktopNotifications: true });
  vi.advanceTimersByTime(100);
  expect(deliveries).not.toHaveBeenCalled();
  ctx.change(initial.agents);
  ctx.change([
    ctx.block(initial.agents[0]!, "2026-08-13T12:00:04Z"),
    initial.agents[1]!,
  ]);
  (Notification as unknown as { permission: string }).permission = "denied";
  vi.advanceTimersByTime(100);
  (Notification as unknown as { permission: string }).permission = "granted";
  ctx.change([
    ctx.block(initial.agents[0]!, "2026-08-13T12:00:04Z"),
    initial.agents[1]!,
  ]);
  vi.advanceTimersByTime(100);
  expect(deliveries).not.toHaveBeenCalled();
  ctx.cleanup();
});
