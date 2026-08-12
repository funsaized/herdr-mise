// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../../protocol/generated/agent-state-event";
import { AgentStore, defaultSettings } from "../state/store";
import {
  Chrome,
  DetailCard,
  ModeTreatment,
  SessionSummary,
  SettingsPanel,
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
      "Lost connection to herdr",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "last update 14s ago",
    );
  });
  it("shows an actionable unsupported protocol diagnostic without conflating malformed input", () => {
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
          supportedProtocols: [17, 19],
          nextAction:
            "upgrade or downgrade Herdr to a tested release, then retry",
        }}
        lastUpdateSeconds={0}
      />,
    );
    const unsupported = screen.getByRole("status").textContent ?? "";
    expect(unsupported).toContain("observed 23");
    expect(unsupported).toContain("supported: 17, 19");
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
    fireEvent.click(screen.getByRole("button", { name: "Dinner" }));
    expect(change).toHaveBeenCalledWith({ theme: "dark" });
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
    const dismiss = vi.fn();
    render(
      <Chrome
        store={store}
        coarse={store.coarse()}
        hoveredId="a"
        focusedId={null}
        hits={[
          {
            kind: "station",
            id: "a",
            rect: { x: 10, y: 100, width: 80, height: 50 },
          },
        ]}
        settingsOpen={false}
        statsOpen={false}
        lastUpdateSeconds={0}
        metrics={{ drawCalls: 0, socketBytesPerSecond: 0 }}
        onCloseSettings={() => {}}
        onOpenSettings={() => {}}
        hintVisible
        onDismissHint={dismiss}
      />,
    );
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Working — on the fire",
    );
    expect(screen.getByLabelText("refactor-auth details")).toBeTruthy();
    expect(store.coarse().selectedId).toBe("a");
    fireEvent.click(screen.getByText("Got it"));
    expect(dismiss).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(store.coarse().selectedId).toBeNull();
  });
  it.each([
    ["blocked", "Blocked — at the pass"],
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
            runtimeMs: 1_000,
            tickets: 0,
            endedAt: Date.now(),
            finalState,
          }}
          onClose={close}
        />,
      );
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByText("Runtime")).toBeTruthy();
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
  it("renders live-agent facts and history without a Herdr action or attach hint", () => {
    const now = Date.now(),
      close = vi.fn();
    render(
      <DetailCard
        agent={{
          ...record,
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
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("/work/app")).toBeTruthy();
    expect(screen.getByText("Tickets this session")).toBeTruthy();
    const history = screen.getByLabelText("Session history");
    expect(history.querySelectorAll(".historyStrip i")).toHaveLength(2);
    expect(history.querySelector('[data-state="working"]')).toBeTruthy();
    expect(screen.queryByText(/Open in herdr/i)).toBeNull();
    expect(screen.queryByText(/herdr attach/i)).toBeNull();
    expect(document.querySelector('a[href^="herdr://agent/"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(close).toHaveBeenCalledOnce();
  });
  it("marks absent live model, workspace, and ticket facts unavailable", () => {
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
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
  });
});
