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
  lastUpdateSeconds,
}: {
  mode: CoarseSlice["mode"];
  sourceStatus: CoarseSlice["sourceStatus"];
  sourceDiagnostic?: SourceDiagnostic | null;
  lastUpdateSeconds: number;
}) {
  const detail =
    sourceStatus === "unsupportedProtocol" && sourceDiagnostic
      ? ` — observed ${sourceDiagnostic.observedProtocol}; supported: ${sourceDiagnostic.supportedProtocols.join(", ")}; ${sourceDiagnostic.nextAction}`
      : "";
  if (mode === "empty")
    return (
      <div className="emptyPill" role="status">
        Waiting for agents — start one in herdr
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
          <strong>Lost connection to herdr</strong>
          <p>
            <i />
            Retrying — last update {lastUpdateSeconds}s ago
          </p>
          <small>
            The kitchen will reopen on its own. If herdr isn't running, start it
            and mise will reconnect.
          </small>
        </div>
      </div>
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
