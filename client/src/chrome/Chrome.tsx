import { useEffect, useRef, useState } from "react";
import { reducedMotionPreference } from "../runtime";
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

const tuiDemoDescription =
  "The herdr-mise terminal runs deterministic demo data, showing its kitchen status before visiting WALK-IN FREEZER.";

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
  view: "kitchen" | "freezer";
  onToggleFreezer(): void;
}

export function Chrome(props: ChromeProps) {
  const [tuiStopped, setTuiStopped] = useState(() =>
      reducedMotionPreference.current(),
    ),
    [tuiExpanded, setTuiExpanded] = useState(false),
    [tuiRestart, setTuiRestart] = useState(0),
    tuiExpandToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => reducedMotionPreference.subscribe(setTuiStopped), []);
  useEffect(() => {
    if (!tuiExpanded) return;
    const collapse = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!tuiExpandToggle.current?.offsetParent) {
        setTuiExpanded(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setTuiExpanded(false);
      requestAnimationFrame(() => tuiExpandToggle.current?.focus());
    };
    window.addEventListener("keydown", collapse, true);
    return () => window.removeEventListener("keydown", collapse, true);
  }, [tuiExpanded]);

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
    hoverAgent = hoverHit ? snapshot.agents.get(hoverHit.id) : undefined,
    selectedHit = props.hits.find(
      (hit) => hit.kind === "station" && hit.id === selectedAgent?.id,
    );
  return (
    <>
      {hoverAgent && hoverHit && <Tooltip agent={hoverAgent} hit={hoverHit} />}
      {selectedAgent && (
        <DetailCard
          agent={selectedAgent}
          hit={selectedHit}
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
        <>
          <button
            className="settingsTrigger freezerTrigger"
            onClick={props.onToggleFreezer}
            aria-pressed={props.view === "freezer"}
          >
            Freezer
          </button>
          <button
            className="settingsTrigger"
            onClick={props.onOpenSettings}
            aria-label="Open settings"
          >
            Settings
          </button>
        </>
      )}
      <ModeTreatment
        mode={props.coarse.mode}
        sourceStatus={props.coarse.sourceStatus}
        sourceDiagnostic={props.coarse.sourceDiagnostic}
        lastUpdateSeconds={props.lastUpdateSeconds}
      />
      {import.meta.env.MODE === "visual" && (
        <figure
          className="visualTuiFigure"
          data-expanded={tuiExpanded}
          aria-label="herdr-mise TUI demo recording"
          aria-describedby="tui-demo-description"
        >
          <picture>
            <img
              src={
                tuiStopped
                  ? "/tui-demo-poster.png"
                  : `/tui-demo.gif${tuiRestart ? `?restart=${tuiRestart}` : ""}`
              }
              alt={
                tuiStopped
                  ? "Still frame of the herdr-mise terminal demo kitchen."
                  : "The herdr-mise terminal demo moving from the kitchen to the walk-in freezer."
              }
            />
          </picture>
          <figcaption>
            Native Ghostty recording of herdr-mise using deterministic demo
            data.
          </figcaption>
          <span id="tui-demo-description" className="visualTuiDescription">
            {tuiDemoDescription}
          </span>
          <div className="visualTuiControls">
            <button
              type="button"
              onClick={() => {
                if (tuiStopped) setTuiRestart((value) => value + 1);
                setTuiStopped(!tuiStopped);
              }}
            >
              {tuiStopped ? "Restart animation" : "Stop animation"}
            </button>
            <button
              ref={tuiExpandToggle}
              type="button"
              aria-expanded={tuiExpanded}
              onClick={() => setTuiExpanded(!tuiExpanded)}
            >
              {tuiExpanded ? "Collapse recording" : "Expand recording"}
            </button>
          </div>
        </figure>
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
