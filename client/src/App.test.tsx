// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { AgentRecord } from "../../protocol/generated/agent-state-event";
import beforeMove from "../../server/tests/fixtures/snapshot-herdr-0.8.2-p20.json";
import afterMove from "../../server/tests/fixtures/snapshot-herdr-0.8.2-p20-moved.json";
const sceneFocus = vi.hoisted(() => vi.fn());
vi.mock("./scene/kitchen-scene", () => ({
  KitchenScene: class {
    init() {
      return Promise.resolve();
    }
    destroy() {}
    setView() {}
    focus = sceneFocus;
    hitTest() {
      return undefined;
    }
    metrics() {
      return { drawCalls: 0 };
    }
  },
}));
import { App } from "./App";
import { SemanticStationControls } from "./chrome/SemanticStationControls";
import { clientStore } from "./runtime";
import {
  freezerAnnouncement,
  freezerInspectorLabel,
  freezerInspectorName,
  humanStateWords,
  nextBlockedAgent,
  orderedBlockedAgents,
  semanticAgentsEqual,
  semanticStationLabel,
  type SemanticAgent,
} from "./state/semantic-stations";
import { BOARD_LIMIT } from "./state/store";
import { isGlobalEscape, isInteractiveKeyboardTarget } from "./keyboard";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  close() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  sceneFocus.mockClear();
  clientStore.select(null);
  clientStore.apply({
    version: 1,
    type: "delta",
    mode: "live",
    operation: "remove",
    agentId: beforeMove.agents[0].terminal_id,
  });
  clientStore.apply({
    version: 1,
    type: "snapshot",
    mode: "demo",
    sourceStatus: "connected",
    agents: [],
  });
  clientStore.apply({
    version: 1,
    type: "snapshot",
    mode: "live",
    sourceStatus: "connected",
    agents: [],
  });
  clientStore.setSettings({ doneTimeoutMs: 600_000 });
  vi.useRealTimers();
});

it("requests pane identity and keeps selected details across a fixture move", () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const beforeAgent = beforeMove.agents[0]!,
    afterAgent = afterMove.agents[0]!,
    beforeWorkspace = beforeMove.workspaces[0]!,
    afterWorkspace = afterMove.workspaces[0]!;
  const record: AgentRecord = {
    id: beforeAgent.terminal_id,
    paneId: beforeAgent.pane_id,
    name: beforeAgent.display_agent,
    state: "working",
    progress: null,
    stateEnteredAt: "2026-08-13T12:00:00Z",
    accentIndex: 1,
    model: "codex",
    workspace: beforeWorkspace.label,
    session: { runtimeMs: 1_000, tickets: 0 },
  };
  render(<App />);
  const socket = FakeWebSocket.instances[0]!;
  expect(socket.url).toMatch(/\/ws\?paneId=1$/);
  act(() =>
    socket.onmessage?.({
      data: JSON.stringify({
        version: 1,
        type: "snapshot",
        mode: "live",
        sourceStatus: "connected",
        agents: [record],
      }),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /example-cook, Working/ }),
  );
  const details = screen.getByLabelText("example-cook details");
  expect(within(details).getByText(beforeWorkspace.label)).toBeTruthy();
  expect(within(details).getByText(beforeAgent.pane_id)).toBeTruthy();
  expect(
    within(details).getByLabelText("Session history").querySelectorAll("li"),
  ).toHaveLength(1);

  act(() =>
    socket.onmessage?.({
      data: JSON.stringify({
        version: 1,
        type: "delta",
        mode: "live",
        operation: "upsert",
        agent: {
          ...record,
          id: afterAgent.terminal_id,
          paneId: afterAgent.pane_id,
          session: { ...record.session, runtimeMs: 2_000 },
        },
      }),
    }),
  );
  let movedDetails = screen.getByLabelText("example-cook details");
  expect(within(movedDetails).getByText(beforeWorkspace.label)).toBeTruthy();
  expect(within(movedDetails).getByText(afterAgent.pane_id)).toBeTruthy();
  expect(screen.getByLabelText("Agent state announcements").textContent).toBe(
    `example-cook moved to ${beforeWorkspace.label}, pane ${afterAgent.pane_id}`,
  );

  act(() =>
    socket.onmessage?.({
      data: JSON.stringify({
        version: 1,
        type: "delta",
        mode: "live",
        operation: "upsert",
        agent: {
          ...record,
          id: afterAgent.terminal_id,
          paneId: afterAgent.pane_id,
          workspace: afterWorkspace.label,
          session: { ...record.session, runtimeMs: 2_000 },
        },
      }),
    }),
  );
  movedDetails = screen.getByLabelText("example-cook details");
  expect(within(movedDetails).getByText(afterWorkspace.label)).toBeTruthy();
  expect(within(movedDetails).getByText(afterAgent.pane_id)).toBeTruthy();
  expect(screen.getByLabelText("Agent state announcements").textContent).toBe(
    `example-cook moved to ${afterWorkspace.label}, pane ${afterAgent.pane_id}`,
  );
  expect(
    within(movedDetails)
      .getByLabelText("Session history")
      .querySelectorAll("li"),
  ).toHaveLength(1);
  expect(clientStore.coarse().selectedId).toBe(beforeAgent.terminal_id);
});

describe("global keyboard routing", () => {
  it.each(["input", "select", "textarea", "button", "summary", "a"])(
    "leaves shortcuts and arrow keys to %s targets",
    (tag) => {
      const element = document.createElement(tag);
      if (tag === "a") element.setAttribute("href", "#");
      document.body.appendChild(element);
      expect(isInteractiveKeyboardTarget(element)).toBe(true);
      element.remove();
    },
  );
  it("leaves nested button targets and editable content alone", () => {
    const button = document.createElement("button"),
      span = document.createElement("span");
    button.appendChild(span);
    expect(isInteractiveKeyboardTarget(span)).toBe(true);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isInteractiveKeyboardTarget(editable)).toBe(true);
  });
  it("allows scene shortcuts from the document body", () =>
    expect(isInteractiveKeyboardTarget(document.body)).toBe(false));
  it("routes Escape globally even when an interactive control owns focus", () => {
    const select = document.createElement("select");
    document.body.appendChild(select);
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(event, "target", { value: select });
    expect(isGlobalEscape(event)).toBe(true);
    expect(isInteractiveKeyboardTarget(event.target)).toBe(true);
    select.remove();
  });
});

describe("semantic station controls", () => {
  const agent: SemanticAgent = {
    id: "a",
    name: "Codex",
    workspace: "Kitchen",
    targetState: "blocked",
    stateEnteredAt: new Date(Date.now() - 65_000).toISOString(),
    blockedPlacement: { kind: "pass", queueOrdinal: 1, queueTotal: 2 },
  };
  it("uses human state wording, stays out of Tab order, and activates details", () => {
    const onSelect = vi.fn();
    render(
      <SemanticStationControls
        agents={[agent]}
        tooltipAgentId="a"
        onSelect={onSelect}
      />,
    );
    const control = screen.getByRole("button", {
      name: "Codex, Blocked — at the pass, queue 1 of 2, open details",
    });
    expect(control.getAttribute("tabindex")).toBe("-1");
    expect(control.getAttribute("aria-describedby")).toBe("station-tooltip-a");
    expect(control.textContent).toMatch(/queue 1 of 2 · 1m \d+s blocked/);
    fireEvent.click(control);
    expect(onSelect).toHaveBeenCalledWith("a", control);
  });
  it("accepts the freezer landmark name without changing button tab behavior", () => {
    render(
      <SemanticStationControls
        agents={[{ ...agent, targetState: "ended" }]}
        label="Ended chefs"
        onSelect={() => {}}
      />,
    );
    const navigation = screen.getByRole("navigation", { name: "Ended chefs" });
    expect(navigation).toBeTruthy();
    expect(
      within(navigation).getByRole("button").getAttribute("tabindex"),
    ).toBe("-1");
  });
  it("keeps same-named ended station controls distinct", () => {
    render(
      <SemanticStationControls
        agents={[
          { ...agent, id: "ended-one", workspace: "", targetState: "ended" },
          { ...agent, id: "ended-two", workspace: "", targetState: "ended" },
        ]}
        label="Ended chefs"
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Codex · Unavailable · ended-one,/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Codex · Unavailable · ended-two,/ }),
    ).toBeTruthy();
  });
  it("keeps colliding controls distinct when pane locators are unavailable", () => {
    render(
      <SemanticStationControls
        agents={[
          { ...agent, id: "terminal-one", paneId: undefined },
          { ...agent, id: "terminal-two", paneId: undefined },
        ]}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Codex · Kitchen · terminal-one"),
        expect.stringContaining("Codex · Kitchen · terminal-two"),
      ]),
    );
  });
  it("exposes keyboard-operable kitchen paging and blocked totals", () => {
    const onPreviousPage = vi.fn(),
      onNextPage = vi.fn(),
      onNextBlocked = vi.fn();
    render(
      <SemanticStationControls
        agents={[agent]}
        page={{
          totalCount: 30,
          visibleCount: 1,
          capacity: 12,
          pageIndex: 1,
          pageCount: 3,
          pagerLayout: "standard",
        }}
        blockedTotal={7}
        blockedVisible={1}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
        onNextBlocked={onNextBlocked}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("Page 2 of 3")).toBeTruthy();
    expect(
      screen.getByText("1 of 30 cooks shown · 7 blocked / 6 off-page"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next blocked cook" }));
    expect(onPreviousPage).toHaveBeenCalledOnce();
    expect(onNextPage).toHaveBeenCalledOnce();
    expect(onNextBlocked).toHaveBeenCalledOnce();
  });
  it("deduplicates source updates that do not change the semantic slice", () => {
    const same = [agent],
      copy = [{ ...agent }];
    expect(semanticAgentsEqual(same, copy)).toBe(true);
    expect(semanticAgentsEqual(same, [{ ...agent, paneId: "moved" }])).toBe(
      false,
    );
    expect(semanticAgentsEqual(same, [{ ...agent, targetState: "done" }])).toBe(
      false,
    );
    expect(
      semanticAgentsEqual(same, [
        { ...agent, stateEnteredAt: new Date().toISOString() },
      ]),
    ).toBe(false);
  });
  it("uses station and location-neutral blocked fallbacks truthfully", () => {
    const { rerender } = render(
      <SemanticStationControls
        agents={[
          {
            ...agent,
            blockedPlacement: {
              kind: "station",
              queueOrdinal: 2,
              queueTotal: 2,
            },
          },
        ]}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: /Blocked — waiting at station, queue 2 of 2, open details/,
      }),
    ).toBeTruthy();
    rerender(
      <SemanticStationControls
        agents={[{ ...agent, blockedPlacement: undefined }]}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Blocked — waiting, open details/ }),
    ).toBeTruthy();
  });
  it("keeps the accessible label contract explicit for every human state", () => {
    for (const targetState of Object.keys(humanStateWords) as Array<
      keyof typeof humanStateWords
    >)
      expect(
        semanticStationLabel({
          ...agent,
          targetState,
          blockedPlacement: undefined,
        }),
      ).toContain(humanStateWords[targetState]);
  });
  it("includes workspace basenames in same-named station controls", () => {
    render(
      <SemanticStationControls
        agents={[
          { ...agent, id: "one", workspace: "/work/one" },
          { ...agent, id: "two", workspace: "/work/two" },
        ]}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Codex · one,/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Codex · two,/ })).toBeTruthy();
  });
});

it("announces dismissal and reveal while removing the cleared station control", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  clientStore.setSettings({ doneTimeoutMs: 50 });
  const agent: AgentRecord = {
    id: "example",
    name: "Example cook",
    state: "done",
    progress: 1,
    stateEnteredAt: "2026-08-13T12:00:00Z",
    accentIndex: 0,
    model: "codex",
    workspace: "/work",
    session: { runtimeMs: 1_000, tickets: 1 },
  };
  clientStore.apply({
    version: 1,
    type: "snapshot",
    mode: "live",
    sourceStatus: "connected",
    agents: [agent],
  });
  render(<App />);
  const station = screen.getByRole("button", {
    name: /Example cook, Done — plated/,
  });
  fireEvent.click(station);
  act(() => vi.advanceTimersByTime(50));
  expect(clientStore.coarse().selectedId).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Example cook, Done/ }),
  ).toBeNull();
  expect(screen.getByLabelText("Agent state announcements").textContent).toBe(
    "Example cook cleared from the kitchen",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "1 plated cook cleared — reveal" }),
  );
  expect(screen.getByLabelText("Agent state announcements").textContent).toBe(
    "1 plated cook revealed",
  );
  expect(
    screen.getByRole("button", { name: /Example cook, Done — plated/ }),
  ).toBeTruthy();
});

it("orders valid blocked timestamps oldest-first and cycles every target", () => {
  const blocked = (id: string, stateEnteredAt: string): SemanticAgent => ({
      id,
      name: id,
      workspace: "",
      stateKnown: true,
      paneId: undefined,
      agentKind: undefined,
      targetState: "blocked",
      stateEnteredAt,
    }),
    agents = [
      blocked("z", "2026-08-01T12:00:00Z"),
      blocked("b", "2026-08-01T11:00:00Z"),
      blocked("a", "2026-08-01T11:00:00Z"),
      blocked("invalid", "unknown"),
      { ...blocked("hidden", "2026-08-01T10:00:00Z"), stateKnown: false },
    ];
  expect(orderedBlockedAgents(agents).map(({ id }) => id)).toEqual([
    "a",
    "b",
    "z",
    "invalid",
  ]);
  expect(nextBlockedAgent(agents, null)?.id).toBe("a");
  expect(nextBlockedAgent(agents, "a")?.id).toBe("b");
  expect(nextBlockedAgent(agents, "invalid")?.id).toBe("a");
});

it("announces empty, decorative vs inspectable, overflow, and latest-50 freezer capacity", () => {
  expect(freezerAnnouncement(0, 0)).toBe("Freezer empty, no ended sessions");
  expect(freezerAnnouncement(1, 1)).toBe(
    "Freezer, 1 decorative spirit, 1 inspectable session",
  );
  expect(freezerAnnouncement(4, 4)).toBe(
    "Freezer, 4 decorative spirits, 4 inspectable sessions",
  );
  expect(freezerAnnouncement(4, 12)).toBe(
    "Freezer, 4 decorative spirits, 12 inspectable sessions, 8 not shown as spirits",
  );
  expect(freezerAnnouncement(4, BOARD_LIMIT)).toBe(
    `Freezer, 4 decorative spirits, ${BOARD_LIMIT} inspectable sessions, ${BOARD_LIMIT - 4} not shown as spirits, latest ${BOARD_LIMIT} retained`,
  );
  expect(freezerAnnouncement(BOARD_LIMIT, BOARD_LIMIT)).toBe(
    `Freezer, ${BOARD_LIMIT} decorative spirits, ${BOARD_LIMIT} inspectable sessions, latest ${BOARD_LIMIT} retained`,
  );
});

it("distinguishes repeated freezer names with ended time or retained ordinal", () => {
  const first = {
      id: "a",
      name: "Codex",
      endedAt: Date.parse("2026-08-13T12:00:00Z"),
    },
    later = {
      id: "a:1",
      name: "Codex",
      endedAt: Date.parse("2026-08-13T12:05:00Z"),
    },
    sameMinute = {
      id: "a:2",
      name: "Codex",
      endedAt: first.endedAt,
    },
    unique = { id: "b", name: "Opus", endedAt: first.endedAt };
  expect(freezerInspectorName(unique, [first, unique])).toBe("Opus");
  expect(freezerInspectorName(first, [first, later])).toBe(
    `Codex · ${new Date(first.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
  );
  expect(freezerInspectorName(first, [first, sameMinute])).toBe(
    "Codex · 1 of 2",
  );
  expect(freezerInspectorName(sameMinute, [first, sameMinute])).toBe(
    "Codex · 2 of 2",
  );
  expect(freezerInspectorLabel(first, [first, sameMinute])).toBe(
    "Codex · 1 of 2, retained 1 of 2, Ended — 86'd, open details",
  );
});

it("lists ended sessions, restores focus, and clears scene focus on Escape", () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const cook = (
    id: string,
    name: string,
    state: AgentRecord["state"] = "working",
  ): AgentRecord => ({
    id,
    name,
    state,
    progress: state === "ended" ? 1 : null,
    stateEnteredAt: "2026-08-13T12:00:00Z",
    accentIndex: 0,
    model: "codex",
    workspace: "/work",
    session: { runtimeMs: 1_000, tickets: 1 },
  });
  clientStore.apply({
    version: 1,
    type: "snapshot",
    mode: "live",
    sourceStatus: "connected",
    agents: [cook("cook-a", "Alpha"), cook("cook-b", "Beta")],
  });
  clientStore.apply({
    version: 1,
    type: "delta",
    mode: "live",
    operation: "upsert",
    agent: cook("cook-a", "Alpha", "ended"),
  });
  clientStore.apply({
    version: 1,
    type: "delta",
    mode: "live",
    operation: "upsert",
    agent: cook("cook-b", "Beta", "ended"),
  });
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Freezer" }));
  const nav = screen.getByRole("navigation", { name: "Ended chefs" });
  const buttons = within(nav).getAllByRole("button");
  expect(buttons.map((button) => button.textContent)).toEqual([
    "Beta",
    "Alpha",
  ]);
  expect(buttons.map((button) => button.getAttribute("data-agent-id"))).toEqual(
    ["cook-b", "cook-a"],
  );
  expect(screen.getByLabelText("Agent state announcements").textContent).toBe(
    "Freezer, 0 decorative spirits, 2 inspectable sessions, 2 not shown as spirits",
  );
  fireEvent.click(buttons[0]!);
  expect(buttons[0]!.getAttribute("aria-current")).toBe("true");
  expect(clientStore.coarse().selectedId).toBe("cook-b");
  expect(screen.getByLabelText("Beta session summary")).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByLabelText("Beta session summary")).toBeNull();
  expect(clientStore.coarse().selectedId).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Freezer" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(document.activeElement).toBe(buttons[0]);
  act(() => {
    clientStore.apply({
      version: 1,
      type: "delta",
      mode: "live",
      operation: "upsert",
      agent: cook("cook-b", "Replacement Beta"),
    });
  });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(
    screen
      .getByRole("button", { name: "Freezer" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  expect(screen.queryByRole("navigation", { name: "Ended chefs" })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Freezer" }),
  );
  expect(sceneFocus).toHaveBeenLastCalledWith(null);
});

it("restores focus to the freezer trigger when the selected session is evicted", () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const cook = (id: string, state: AgentRecord["state"]): AgentRecord => ({
    id,
    name: id,
    state,
    progress: state === "ended" ? 1 : null,
    stateEnteredAt: "2026-08-13T12:00:00Z",
    accentIndex: 0,
    model: "codex",
    workspace: "/work",
    session: { runtimeMs: 1_000, tickets: 1 },
  });
  for (let index = 0; index < BOARD_LIMIT; index++) {
    clientStore.apply({
      version: 1,
      type: "delta",
      mode: "live",
      operation: "upsert",
      agent: cook(`cook-${index}`, "working"),
    });
    clientStore.apply({
      version: 1,
      type: "delta",
      mode: "live",
      operation: "upsert",
      agent: cook(`cook-${index}`, "ended"),
    });
  }
  render(<App />);
  const freezer = screen.getByRole("button", { name: "Freezer" });
  fireEvent.click(freezer);
  const oldest = within(screen.getByRole("navigation", { name: "Ended chefs" }))
    .getAllByRole("button")
    .at(-1)!;
  fireEvent.click(oldest);
  act(() => {
    clientStore.apply({
      version: 1,
      type: "delta",
      mode: "live",
      operation: "upsert",
      agent: cook("replacement", "working"),
    });
    clientStore.apply({
      version: 1,
      type: "delta",
      mode: "live",
      operation: "upsert",
      agent: cook("replacement", "ended"),
    });
  });
  expect(oldest.isConnected).toBe(false);
  expect(clientStore.coarse().selectedId).toBeNull();
  expect(document.activeElement).toBe(freezer);
});

it("selects the exact reused board id and shows an empty freezer inspector", () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const pane: AgentRecord = {
    id: "p-1",
    name: "Codex",
    state: "working",
    progress: null,
    stateEnteredAt: "2026-08-13T12:00:00Z",
    accentIndex: 0,
    model: "codex",
    workspace: "/work",
    session: { runtimeMs: 1_000, tickets: 1 },
  };
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Freezer" }));
  expect(screen.getByText("No ended sessions")).toBeTruthy();
  expect(screen.getByLabelText("Agent state announcements").textContent).toBe(
    "Freezer empty, no ended sessions",
  );
  fireEvent.click(screen.getByRole("button", { name: "Freezer" }));
  act(() => {
    clientStore.apply({
      version: 1,
      type: "snapshot",
      mode: "live",
      sourceStatus: "connected",
      agents: [pane],
    });
    clientStore.apply({
      version: 1,
      type: "delta",
      mode: "live",
      operation: "upsert",
      agent: { ...pane, state: "ended" },
    });
    clientStore.apply({
      version: 1,
      type: "delta",
      mode: "live",
      operation: "upsert",
      agent: { ...pane, state: "idle" },
    });
    clientStore.apply({
      version: 1,
      type: "delta",
      mode: "live",
      operation: "upsert",
      agent: {
        ...pane,
        state: "ended",
        session: { runtimeMs: 2_000, tickets: 3 },
      },
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Freezer" }));
  const buttons = within(
    screen.getByRole("navigation", { name: "Ended chefs" }),
  ).getAllByRole("button");
  expect(buttons.map((button) => button.getAttribute("data-agent-id"))).toEqual(
    ["p-1:1", "p-1"],
  );
  fireEvent.click(buttons[0]!);
  expect(buttons[0]!.getAttribute("aria-current")).toBe("true");
  expect(clientStore.coarse().selectedId).toBe("p-1:1");
  expect(screen.getByLabelText("Codex session summary")).toBeTruthy();
  expect(screen.getByText("2s")).toBeTruthy();
});
