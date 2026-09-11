// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRecord,
  AgentStateEvent,
} from "../../../protocol/generated/agent-state-event";
import snapshot from "../../../protocol/fixtures/snapshot.v1.json";
import unsupported from "../../../protocol/fixtures/snapshot-demo-unsupported.v1.json";
import { AgentStore, defaultSettings } from "../state/store";
import { AgentWebSocketClient, type SocketLike } from "../state/ws-client";
import {
  Chrome,
  DetailCard,
  ModeTreatment,
  SessionSummary,
  SettingsPanel,
  Tooltip,
} from "./Chrome";

afterEach(cleanup);
const record: AgentRecord = {
  id: "a",
  name: "refactor-auth",
  state: "working",
  progress: 0.5,
  stateEnteredAt: new Date().toISOString(),
  accentIndex: 1,
  model: "codex",
  workspace: "/work/app",
  session: { runtimeMs: 1_000, tickets: 2 },
};
describe("chrome interactions", () => {
  it("moves initial focus into settings and detail panels", () => {
    const { unmount } = render(
      <SettingsPanel
        settings={defaultSettings}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText("Settings")).toBe(document.activeElement);
    unmount();
    render(
      <DetailCard
        agent={{
          ...record,
          targetState: "working",
          renderedState: "working",
          transitionStartedAt: 0,
          clearAt: null,
          answerReceivedUntil: null,
          revision: 1,
          history: [{ state: "working", startedAt: Date.now() }],
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText("refactor-auth details")).toBe(
      document.activeElement,
    );
  });
  it("renders exact mode truth treatments", () => {
    const { rerender } = render(
      <ModeTreatment
        mode="empty"
        sourceStatus="connected"
        lastUpdateSeconds={0}
      />,
    );
    expect(
      screen.getByText("Waiting for agents — start one in herdr"),
    ).toBeTruthy();
    rerender(
      <ModeTreatment
        mode="empty"
        sourceStatus="connected"
        lastUpdateSeconds={0}
        scopeEmptyLabel="Kitchen One"
        scopeUnavailableLabel="Removed Kitchen"
      />,
    );
    expect(
      screen.getByText("Waiting for agents — start one in herdr"),
    ).toBeTruthy();
    expect(screen.queryByText("No agents in Kitchen One")).toBeNull();
    expect(screen.queryByText("Removed Kitchen is unavailable")).toBeNull();
    rerender(
      <ModeTreatment
        mode="demo"
        sourceStatus="unavailableSocket"
        lastUpdateSeconds={0}
      />,
    );
    expect(screen.getByText("DEMO SERVICE")).toBeTruthy();
    rerender(
      <ModeTreatment
        mode="disconnected"
        sourceStatus="connected"
        lastUpdateSeconds={14}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Lost connection to Mise",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "last update 14s ago",
    );
    rerender(
      <ModeTreatment
        mode="disconnected"
        sourceStatus="connected"
        disconnectReason="incompatibleFeed"
        lastUpdateSeconds={14}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Browser received an incompatible Mise feed",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Waiting for a compatible snapshot",
    );
    expect(screen.getByRole("alert").textContent).not.toContain(
      "Lost connection to Mise",
    );
  });
  it("shows actionable source diagnostics without conflating malformed input", () => {
    const { rerender } = render(
      <ModeTreatment
        mode="demo"
        sourceStatus="unavailableSocket"
        sourceDiagnostic={null}
        lastUpdateSeconds={0}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "socket unavailable",
    );
    rerender(
      <ModeTreatment
        mode="demo"
        sourceStatus="unsupportedProtocol"
        sourceDiagnostic={{
          observedProtocol: 23,
          supportedProtocols: [17, 19, 20],
          nextAction:
            "upgrade or downgrade Herdr to a tested release, then retry",
        }}
        lastUpdateSeconds={0}
      />,
    );
    const unsupported = screen.getByRole("status").textContent ?? "";
    expect(unsupported).toContain("observed 23");
    expect(unsupported).toContain("supported: 17, 19, 20");
    expect(unsupported).toContain("upgrade or downgrade Herdr");
    rerender(
      <ModeTreatment
        mode="demo"
        sourceStatus="incompatibleResponse"
        sourceDiagnostic={null}
        lastUpdateSeconds={0}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "incompatible response",
    );
    expect(screen.getByRole("status").textContent).not.toContain("observed 23");
    rerender(
      <ModeTreatment
        mode="demo"
        sourceStatus="incompatibleResponse"
        sourceDiagnostic={{
          observedProtocol: 20,
          supportedProtocols: [17, 19, 20],
          nextAction: "ensure terminal identities are unique, then retry",
        }}
        lastUpdateSeconds={0}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "ensure terminal identities are unique, then retry",
    );
    rerender(
      <ModeTreatment
        mode="disconnected"
        sourceStatus="incompatibleResponse"
        sourceDiagnostic={{
          observedProtocol: 20,
          supportedProtocols: [17, 19, 20],
          nextAction: "ensure terminal identities are unique, then retry",
        }}
        lastUpdateSeconds={1}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "ensure terminal identities are unique, then retry",
    );
  });
  it("round-trips settings controls", () => {
    const change = vi.fn(),
      close = vi.fn();
    render(
      <SettingsPanel
        settings={defaultSettings}
        onChange={change}
        onClose={close}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Service bell" }));
    expect(change).toHaveBeenCalledWith({ sound: true });
    const atmosphere = screen.getByRole("switch", { name: "Atmosphere" });
    expect(atmosphere.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(atmosphere);
    expect(change).toHaveBeenCalledWith({ atmosphere: false });
    fireEvent.click(screen.getByRole("button", { name: "Dinner" }));
    expect(change).toHaveBeenCalledWith({ theme: "dark" });
    expect(
      screen.getByText(
        "Also applies to dishes already plated, preserving elapsed time",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Done timeout" }), {
      target: { value: "1200000" },
    });
    expect(change).toHaveBeenCalledWith({ doneTimeoutMs: 1_200_000 });
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(close).toHaveBeenCalledOnce();
  });
  it("integrates hover, detail selection, close, and first-run dismissal", () => {
    const store = new AgentStore();
    store.apply({
      version: 1,
      type: "snapshot",
      mode: "live",
      sourceStatus: "connected",
      agents: [record],
    });
    store.select("a");
    const dismiss = vi.fn(),
      props = {
        store,
        coarse: store.coarse(),
        hoveredId: "a",
        focusedId: null,
        hits: [
          {
            kind: "station" as const,
            id: "a",
            rect: { x: 10, y: 100, width: 80, height: 50 },
          },
        ],
        settingsOpen: false,
        statsOpen: false,
        lastUpdateSeconds: 0,
        metrics: { drawCalls: 0, socketBytesPerSecond: 0 },
        onCloseSettings: () => {},
        onOpenSettings: () => {},
        hintVisible: true,
        onDismissHint: dismiss,
        view: "kitchen" as const,
        onToggleFreezer: () => {},
        onNextBlocked: () => {},
        onRevealCleared: () => {},
      },
      { rerender } = render(<Chrome {...props} />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByLabelText("refactor-auth details")).toBeTruthy();
    expect(store.coarse().selectedId).toBe("a");
    fireEvent.click(screen.getByText("Got it"));
    expect(dismiss).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(store.coarse().selectedId).toBeNull();
    rerender(<Chrome {...props} coarse={store.coarse()} hintVisible={false} />);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Working — on the fire",
    );
    store.select("a");
    rerender(
      <Chrome
        {...props}
        coarse={store.coarse()}
        settingsOpen
        hintVisible={false}
      />,
    );
    expect(screen.getByLabelText("Settings")).toBeTruthy();
    expect(screen.queryByLabelText("refactor-auth details")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.querySelectorAll("aside.panel")).toHaveLength(1);
  });
  it("exposes a native boolean freezer toggle", () => {
    const store = new AgentStore(),
      toggle = vi.fn();
    store.apply({
      version: 1,
      type: "snapshot",
      mode: "live",
      sourceStatus: "connected",
      agents: [{ ...record, state: "blocked" }],
    });
    render(
      <Chrome
        store={store}
        coarse={store.coarse()}
        hoveredId={null}
        focusedId={null}
        hits={[]}
        settingsOpen={false}
        statsOpen={false}
        lastUpdateSeconds={0}
        metrics={{ drawCalls: 0, socketBytesPerSecond: 0 }}
        onCloseSettings={() => {}}
        onOpenSettings={() => {}}
        hintVisible={false}
        onDismissHint={() => {}}
        view="freezer"
        onToggleFreezer={toggle}
        onNextBlocked={() => {}}
        onRevealCleared={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "Freezer" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Next blocked: refactor-auth",
      }).disabled,
    ).toBe(true);
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledOnce();
  });
  it("shows observed service counts and names the next blocked target", () => {
    const store = new AgentStore(),
      next = vi.fn(),
      oldest = {
        ...record,
        id: "oldest",
        name: "Oldest cook",
        workspaceId: "one",
        state: "blocked" as const,
        stateEnteredAt: new Date(Date.now() - 60_000).toISOString(),
      },
      outside = {
        ...oldest,
        id: "outside",
        name: "Outside cook",
        workspaceId: "two",
        stateEnteredAt: new Date(Date.now() - 120_000).toISOString(),
      };
    store.apply({
      version: 1,
      type: "snapshot",
      mode: "live",
      sourceStatus: "connected",
      agents: [oldest, { ...record, id: "newer", workspaceId: "one" }, outside],
      workspaces: [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ],
    });
    store.selectWorkspace("one");
    render(
      <Chrome
        store={store}
        coarse={store.coarse()}
        hoveredId={null}
        focusedId={null}
        hits={[]}
        settingsOpen={false}
        statsOpen={false}
        lastUpdateSeconds={0}
        metrics={{ drawCalls: 0, socketBytesPerSecond: 0 }}
        onCloseSettings={() => {}}
        onOpenSettings={() => {}}
        hintVisible={false}
        onDismissHint={() => {}}
        view="kitchen"
        onToggleFreezer={() => {}}
        onNextBlocked={next}
        onRevealCleared={() => {}}
      />,
    );
    const summary = screen.getByRole("region", {
      name: "Observed service summary",
    });
    expect(summary.textContent).toContain("Working 1");
    expect(summary.textContent).toContain("Blocked 1");
    expect(summary.textContent).toContain("Shown 2 of 2");
    expect(summary.textContent).toContain("Oldest blocked: Oldest cook");
    expect(summary.textContent).not.toContain("Outside cook");
    const button = screen.getByRole("button", {
      name: "Next blocked: Oldest cook",
    });
    expect(button.closest("[aria-live]")).toBeNull();
    fireEvent.click(button);
    expect(next).toHaveBeenCalledOnce();
  });
  it("reveals locally cleared plated cooks with a native live-only control", () => {
    const reveal = vi.fn(),
      { rerender } = render(
        <ModeTreatment
          mode="live"
          sourceStatus="connected"
          lastUpdateSeconds={0}
          clearedCount={1}
          onRevealCleared={reveal}
        />,
      );
    fireEvent.click(
      screen.getByRole("button", { name: "1 plated cook cleared — reveal" }),
    );
    expect(reveal).toHaveBeenCalledOnce();
    rerender(
      <ModeTreatment
        mode="demo"
        sourceStatus="connected"
        lastUpdateSeconds={0}
        clearedCount={2}
        onRevealCleared={reveal}
      />,
    );
    expect(screen.queryByText(/plated cooks cleared/)).toBeNull();
    expect(screen.getByText("DEMO SERVICE")).toBeTruthy();
    rerender(
      <ModeTreatment
        mode="live"
        sourceStatus="connected"
        lastUpdateSeconds={0}
        scopeEmptyLabel="Kitchen One"
        clearedCount={2}
        onRevealCleared={reveal}
      />,
    );
    expect(screen.getByText("No agents in Kitchen One")).toBeTruthy();
    expect(screen.queryByText(/plated cooks cleared/)).toBeNull();
  });
  it("closes a selected demo session summary on live recovery", () => {
    const store = new AgentStore();
    store.apply({
      version: 1,
      type: "snapshot",
      mode: "demo",
      sourceStatus: "unavailableSocket",
      agents: [record],
    });
    store.apply({
      version: 1,
      type: "delta",
      mode: "demo",
      operation: "upsert",
      agent: { ...record, state: "ended" },
    });
    store.select(record.id);
    const props = {
        store,
        coarse: store.coarse(),
        hoveredId: null,
        focusedId: null,
        hits: [],
        settingsOpen: false,
        statsOpen: false,
        lastUpdateSeconds: 0,
        metrics: { drawCalls: 0, socketBytesPerSecond: 0 },
        onCloseSettings: () => {},
        onOpenSettings: () => {},
        hintVisible: false,
        onDismissHint: () => {},
        view: "kitchen" as const,
        onToggleFreezer: () => {},
        onNextBlocked: () => {},
        onRevealCleared: () => {},
      },
      { rerender } = render(<Chrome {...props} />);
    expect(screen.getByLabelText("refactor-auth session summary")).toBeTruthy();

    store.apply(snapshot as AgentStateEvent);
    rerender(<Chrome {...props} coarse={store.coarse()} />);
    expect(screen.queryByLabelText("refactor-auth session summary")).toBeNull();
    expect(store.coarse().selectedId).toBeNull();
    expect(screen.getByRole("button", { name: "Open settings" })).toBe(
      document.activeElement,
    );
    store.destroy();
  });
  it("offers duplicate workspace scopes and reveals blocked elsewhere with restored focus", () => {
    const store = new AgentStore();
    store.apply({
      version: 1,
      type: "snapshot",
      mode: "live",
      sourceStatus: "connected",
      agents: [
        { ...record, workspaceId: "workspace-one" },
        { ...record, id: "b", state: "blocked", workspaceId: "workspace-two" },
      ],
      workspaces: [
        { id: "workspace-one", label: "/srv/same" },
        { id: "workspace-two", label: String.raw`C:\srv\same` },
      ],
    });
    store.selectWorkspace("workspace-one");
    const props = {
        store,
        coarse: store.coarse(),
        hoveredId: null,
        focusedId: null,
        hits: [],
        settingsOpen: false,
        statsOpen: false,
        lastUpdateSeconds: 0,
        metrics: { drawCalls: 0, socketBytesPerSecond: 0 },
        onCloseSettings: () => {},
        onOpenSettings: () => {},
        hintVisible: false,
        onDismissHint: () => {},
        view: "kitchen" as const,
        onToggleFreezer: () => {},
        onNextBlocked: () => {},
        onRevealCleared: () => {},
      },
      { rerender } = render(<Chrome {...props} />),
      select = screen.getByRole("combobox", { name: "Workspace" });
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["All", "same (aceone)", "same (acetwo)"]);
    const showAll = screen.getByRole("button", {
      name: "1 blocked elsewhere — Show all",
    });
    fireEvent.keyDown(select, { key: "Tab" });
    expect(document.activeElement).toBe(showAll);
    fireEvent.click(showAll);
    rerender(<Chrome {...props} coarse={store.coarse()} />);
    expect(store.coarse().selectedWorkspaceId).toBeNull();
    expect(document.activeElement).toBe(select);
  });
  it.each([
    ["blocked", "Blocked — waiting"],
    ["working", "Working — on the fire"],
    ["done", "Done — plated"],
  ] as const)(
    "renders a truthful %s session ending without fabricated history or Herdr action",
    (finalState, label) => {
      const close = vi.fn();
      render(
        <SessionSummary
          entry={{
            id: "a",
            name: "agent",
            accentIndex: 0,
            runtimeMs: 1_000,
            tickets: 0,
            endedAt: Date.now(),
            finalState,
          }}
          onClose={close}
        />,
      );
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByText("Mise time")).toBeTruthy();
      expect(screen.getByText("Tickets served")).toBeTruthy();
      expect(screen.getByText("Ended at")).toBeTruthy();
      expect(screen.getByText("Final state")).toBeTruthy();
      expect(screen.getByText("Unavailable")).toBeTruthy();
      expect(screen.queryByLabelText("Session history")).toBeNull();
      expect(screen.queryByText(/View transcript in herdr/i)).toBeNull();
      expect(document.querySelector('a[href^="herdr://session/"]')).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
      expect(close).toHaveBeenCalledOnce();
      cleanup();
    },
  );
  it("uses current blocked placement in tooltips and details", () => {
    const agent = {
        ...record,
        state: "blocked" as const,
        targetState: "blocked" as const,
        renderedState: "blocked" as const,
        transitionStartedAt: 0,
        clearAt: null,
        answerReceivedUntil: null,
        revision: 1,
        history: [{ state: "blocked" as const, startedAt: Date.now() }],
      },
      hit = {
        kind: "station" as const,
        id: "a",
        rect: { x: 10, y: 10, width: 80, height: 50 },
        blockedPlacement: {
          kind: "station" as const,
          queueOrdinal: 6,
          queueTotal: 12,
        },
      };
    const { unmount } = render(<Tooltip agent={agent} hit={hit} />);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Blocked — waiting at station · queue 6 of 12",
    );
    expect(screen.getByRole("tooltip").id).toBe("station-tooltip-a");
    expect(screen.getByRole("tooltip").getAttribute("data-placement")).toBe(
      "below",
    );
    unmount();
    render(<DetailCard agent={agent} hit={hit} onClose={() => {}} />);
    expect(
      screen.getByText("BLOCKED — WAITING AT STATION · QUEUE 6 OF 12"),
    ).toBeTruthy();
  });
  it("renders live-agent facts and history without a Herdr action or attach hint", () => {
    const now = Date.now(),
      close = vi.fn();
    render(
      <DetailCard
        agent={{
          ...record,
          workspace: "/work/\u001bapp",
          agentKind: "co\u0085dex",
          stateEnteredAt: new Date(now - 10_000).toISOString(),
          targetState: "working",
          renderedState: "working",
          transitionStartedAt: 0,
          clearAt: null,
          answerReceivedUntil: null,
          revision: 1,
          history: [
            { state: "idle", startedAt: now - 60_000 },
            { state: "working", startedAt: now - 10_000 },
          ],
        }}
        onClose={close}
      />,
    );
    expect(screen.getByRole("heading", { name: "refactor-auth" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "app" })).toBeNull();
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("Tickets this session")).toBeTruthy();
    expect(screen.getByLabelText("Session history")).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "Observed state periods" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("listitem", { name: /Idle — prepping period 1,/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("listitem", {
        name: /Working — on the fire period 2,.*to now/,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Open in herdr/i)).toBeNull();
    expect(screen.queryByText(/herdr attach/i)).toBeNull();
    expect(document.querySelector('a[href^="herdr://agent/"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(close).toHaveBeenCalledOnce();
  });
  it("marks absent live workspace and ticket facts unavailable", () => {
    render(
      <DetailCard
        agent={{
          ...record,
          model: "",
          workspace: "",
          session: { ...record.session, tickets: 0 },
          targetState: "working",
          renderedState: "working",
          transitionStartedAt: 0,
          clearAt: null,
          answerReceivedUntil: null,
          revision: 1,
          history: [{ state: "working", startedAt: Date.now() }],
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(4);
  });
  it("copies the exact pane locator and announces clipboard failure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const agent = {
      ...record,
      paneId: "pane-🥘-exact",
      agentKind: "codex",
      targetState: "working" as const,
      renderedState: "working" as const,
      transitionStartedAt: 0,
      clearAt: null,
      answerReceivedUntil: null,
      revision: 1,
      history: [{ state: "working" as const, startedAt: Date.now() }],
    };
    const { rerender } = render(
      <DetailCard agent={agent} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy locator" }));
    expect(await screen.findByText("Locator copied")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("pane-🥘-exact");
    expect(screen.getByText("Attempt 1:")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy locator" }));
    expect(await screen.findByText("Attempt 2:")).toBeTruthy();

    rerender(
      <DetailCard
        agent={{ ...agent, paneId: "pane-🥘-moved" }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText("Locator copied")).toBeNull();

    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy locator" }));
    expect(await screen.findByText(/Copy failed/)).toBeTruthy();
    expect(screen.getByText("Attempt 3:")).toBeTruthy();
    expect(screen.getByText("pane-🥘-moved")).toBeTruthy();
  });
  it("distinguishes observed zero tickets from unknown source state", () => {
    const store = new AgentStore();
    store.apply({
      version: 1,
      type: "snapshot",
      mode: "live",
      sourceStatus: "connected",
      agents: [
        {
          ...record,
          stateKnown: false,
          session: { runtimeMs: 0, tickets: 0, ticketsAvailable: true },
        },
      ],
    });
    render(
      <DetailCard
        agent={store.snapshot().agents.get(record.id)!}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("UNKNOWN — AT PREP")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
    store.destroy();
  });
  it("shows DEMO SERVICE for an empty unsupported websocket snapshot", () => {
    const store = new AgentStore(),
      socket = new FakeSocket(),
      client = new AgentWebSocketClient("ws://test", store, () => socket);
    client.start();
    socket.open();
    socket.message(unsupported);
    const coarse = store.coarse();
    render(
      <ModeTreatment
        mode={coarse.mode}
        sourceStatus={coarse.sourceStatus}
        sourceDiagnostic={coarse.sourceDiagnostic}
        lastUpdateSeconds={0}
      />,
    );
    expect(screen.getByText("DEMO SERVICE")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("observed 23");
    expect(
      screen.queryByText("Waiting for agents — start one in herdr"),
    ).toBeNull();
    client.stop();
  });
});

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
