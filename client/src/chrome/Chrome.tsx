import type { SceneHit } from "../scene/kitchen-scene";
import type { AgentStore, CoarseSlice } from "../state/store";
import { DetailCard, SessionSummary, Tooltip } from "./agent-panels";
import { SettingsPanel } from "./settings-panel";
import {
  ModeTreatment,
  StatsOverlay,
  type DebugMetrics,
} from "./status-panels";

export { DetailCard, SessionSummary, Tooltip } from "./agent-panels";
export { SettingsPanel } from "./settings-panel";
export { ModeTreatment, StatsOverlay } from "./status-panels";
export type { DebugMetrics } from "./status-panels";

export interface ChromeProps {
  store: AgentStore;
  coarse: CoarseSlice;
  hoveredId: string | null;
  focusedId: string | null;
  hits: readonly SceneHit[];
  settingsOpen: boolean;
  statsOpen: boolean;
  lastUpdateSeconds: number;
  metrics: DebugMetrics;
  onCloseSettings(): void;
  onOpenSettings(): void;
  onDismissHint(): void;
  hintVisible: boolean;
}

export function Chrome(props: ChromeProps) {
  const snapshot = props.store.snapshot(),
    selectedAgent = props.coarse.selectedId
      ? snapshot.agents.get(props.coarse.selectedId)
      : undefined,
    selectedBoard = props.coarse.selectedId
      ? snapshot.board.find((item) => item.id === props.coarse.selectedId)
      : undefined;
  const hoverHit = props.hits.find(
      (hit) =>
        hit.kind === "station" &&
        hit.id === (props.hoveredId ?? props.focusedId),
    ),
    hoverAgent = hoverHit ? snapshot.agents.get(hoverHit.id) : undefined;
  return (
    <>
      {hoverAgent && hoverHit && <Tooltip agent={hoverAgent} hit={hoverHit} />}
      {selectedAgent && (
        <DetailCard
          agent={selectedAgent}
          onClose={() => props.store.select(null)}
        />
      )}
      {selectedBoard && (
        <SessionSummary
          entry={selectedBoard}
          onClose={() => props.store.select(null)}
        />
      )}
      {props.settingsOpen && (
        <SettingsPanel
          settings={props.coarse.settings}
          onChange={(patch) => props.store.setSettings(patch)}
          onClose={props.onCloseSettings}
        />
      )}
      {!props.settingsOpen && (
        <button
          className="settingsTrigger"
          onClick={props.onOpenSettings}
          aria-label="Open settings"
        >
          Settings
        </button>
      )}
      <ModeTreatment
        mode={props.coarse.mode}
        sourceStatus={props.coarse.sourceStatus}
        sourceDiagnostic={props.coarse.sourceDiagnostic}
        lastUpdateSeconds={props.lastUpdateSeconds}
      />
      {import.meta.env.MODE === "visual" && (
        <picture className="visualTuiFigure">
          <source
            media="(prefers-reduced-motion: reduce)"
            srcSet="/tui-demo-poster.png"
          />
          <img
            src="/tui-demo.gif"
            alt="Terminal herdr-mise kitchen with the persistent MISE — DEMO SERVICE label."
          />
        </picture>
      )}
      {props.hintVisible && (
        <div className="firstHint" role="note">
          Blocked cooks ring the service bell.{" "}
          <button onClick={props.onDismissHint}>Got it</button>
        </div>
      )}
      {props.statsOpen && <StatsOverlay metrics={props.metrics} />}
    </>
  );
}
