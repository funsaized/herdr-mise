import type { SourceDiagnostic } from "../../../protocol/generated/agent-state-event";
import type { CoarseSlice } from "../state/store";

export interface DebugMetrics {
  drawCalls: number;
  socketBytesPerSecond: number;
}

const sourceStatusText = {
  unavailableSocket: "Herdr socket unavailable",
  timeout: "Herdr did not respond in time",
  unsupportedProtocol: "Herdr protocol is unsupported",
  incompatibleResponse: "Herdr returned an incompatible response",
  connected: "Connected to Herdr",
} as const;

export function ModeTreatment({
  mode,
  sourceStatus,
  sourceDiagnostic = null,
  disconnectReason = null,
  lastUpdateSeconds,
  scopeEmptyLabel = null,
  scopeUnavailableLabel = null,
  clearedCount,
  onRevealCleared,
}: {
  mode: CoarseSlice["mode"];
  sourceStatus: CoarseSlice["sourceStatus"];
  sourceDiagnostic?: SourceDiagnostic | null;
  disconnectReason?: CoarseSlice["disconnectReason"];
  lastUpdateSeconds: number;
  scopeEmptyLabel?: string | null;
  scopeUnavailableLabel?: string | null;
  clearedCount?: number;
  onRevealCleared?(): void;
}) {
  const detail = sourceDiagnostic
    ? sourceStatus === "unsupportedProtocol"
      ? ` — observed ${sourceDiagnostic.observedProtocol}; supported: ${sourceDiagnostic.supportedProtocols.join(", ")}; ${sourceDiagnostic.nextAction}`
      : sourceStatus === "incompatibleResponse"
        ? ` — ${sourceDiagnostic.nextAction}`
        : ""
    : "";
  if (mode === "connecting")
    return (
      <div className="emptyPill" role="status">
        Connecting to Mise — waiting for agent state
      </div>
    );
  if (mode === "demo")
    return (
      <div className="demoPlacard" role="status">
        <h2>DEMO SERVICE</h2>
        <hr />
        <p>
          Mock feed — {sourceStatusText[sourceStatus]}
          {detail}. Nothing here is real.
        </p>
        <small>POSTED PER ORDINANCE 86.86</small>
      </div>
    );
  if (mode === "disconnected")
    return (
      <div className="disconnectScrim">
        <div className="disconnectCard" role="alert">
          <h2>GAS LEAK — SERVICE SUSPENDED</h2>
          <strong>
            {disconnectReason === "incompatibleFeed"
              ? "Browser received an incompatible Mise feed"
              : "Lost connection to Mise"}
          </strong>
          <p>
            <i />
            {disconnectReason === "incompatibleFeed"
              ? "Waiting for a compatible snapshot"
              : `Retrying — last update ${lastUpdateSeconds}s ago`}
          </p>
          <small>
            {disconnectReason === "incompatibleFeed"
              ? "The browser rejected repeated state updates from Mise. Update or restart Mise; no malformed state was applied."
              : `${sourceStatus !== "connected" ? `${sourceStatusText[sourceStatus]}${detail}. ` : ""}The kitchen will reopen on its own. Check that Mise is running; Mise will reconnect to Herdr when its local source is available.`}
          </small>
        </div>
      </div>
    );
  if (mode === "empty")
    return (
      <div className="emptyPill" role="status">
        Waiting for agents — start one in herdr
      </div>
    );
  if (scopeUnavailableLabel !== null)
    return (
      <div className="emptyPill" role="status">
        {scopeUnavailableLabel} is unavailable
      </div>
    );
  if (scopeEmptyLabel !== null)
    return (
      <div className="emptyPill" role="status">
        No agents in {scopeEmptyLabel}
      </div>
    );
  if (mode === "live" && clearedCount)
    return (
      <button className="revealCleared" type="button" onClick={onRevealCleared}>
        {clearedCount} plated cook{clearedCount === 1 ? "" : "s"} cleared —
        reveal
      </button>
    );
  return null;
}

export function StatsOverlay({ metrics }: { metrics: DebugMetrics }) {
  return (
    <output className="statsOverlay" aria-label="Performance statistics">
      <b>MISE STATS</b>
      <span>draw calls {metrics.drawCalls}</span>
      <span>socket {metrics.socketBytesPerSecond} B/s</span>
    </output>
  );
}
