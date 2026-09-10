import { useEffect, useRef, useState } from "react";
import { reducedMotionPreference } from "../runtime";
import { workspaceDisplayName } from "../scene/geometry";
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

function shortWorkspaceId(id: string) {
  const compact = id.replace(/[^A-Za-z0-9]+/g, "");
  return compact.slice(-6) || id.slice(-6);
}
function workspaceOptionLabel(
  id: string,
  label: string,
  catalog: readonly { id: string; label: string }[],
) {
  const text = label ? workspaceDisplayName(label) : shortWorkspaceId(id),
    duplicate =
      catalog.filter(
        (item) =>
          (item.label
            ? workspaceDisplayName(item.label)
            : shortWorkspaceId(item.id)) === text,
      ).length > 1;
  return duplicate ? `${text} (${shortWorkspaceId(id)})` : text;
}
function workspaceScopeName(label: string | null) {
  const text = label?.trim();
  return text ? workspaceDisplayName(text) : "this workspace";
}
function workspaceOptions(coarse: CoarseSlice) {
  const options = [...coarse.workspaces];
  if (
    coarse.workspaceUnavailable &&
    coarse.selectedWorkspaceId &&
    !options.some((item) => item.id === coarse.selectedWorkspaceId)
  )
    options.push({
      id: coarse.selectedWorkspaceId,
      label: coarse.selectedWorkspaceLabel ?? "",
    });
  return options;
}

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
  onRevealCleared(): void;
}

export function Chrome(props: ChromeProps) {
  const [tuiStopped, setTuiStopped] = useState(() =>
      reducedMotionPreference.current(),
    ),
    [tuiExpanded, setTuiExpanded] = useState(false),
    [tuiRestart, setTuiRestart] = useState(0),
    tuiExpandToggle = useRef<HTMLButtonElement>(null),
    workspaceSelect = useRef<HTMLSelectElement>(null),
    workspaceShowAll = useRef<HTMLButtonElement>(null),
    openSettings = useRef<HTMLButtonElement>(null),
    previousSelectedId = useRef(props.coarse.selectedId);
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
    selectedAgent =
      props.coarse.selectedId &&
      snapshot.visibleAgents.has(props.coarse.selectedId)
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
    hoverAgent =
      hoverHit && snapshot.visibleAgents.has(hoverHit.id)
        ? snapshot.agents.get(hoverHit.id)
        : undefined,
    selectedHit = props.hits.find(
      (hit) => hit.kind === "station" && hit.id === selectedAgent?.id,
    ),
    primaryPanelOpen = Boolean(
      props.settingsOpen || selectedAgent || selectedBoard,
    ),
    catalog = workspaceOptions(props.coarse);
  useEffect(() => {
    if (!primaryPanelOpen || !tuiExpanded) return;
    const frame = requestAnimationFrame(() => setTuiExpanded(false));
    return () => cancelAnimationFrame(frame);
  }, [primaryPanelOpen, tuiExpanded]);
  useEffect(() => {
    if (
      previousSelectedId.current !== null &&
      props.coarse.selectedId === null &&
      document.activeElement === document.body
    )
      openSettings.current?.focus();
    previousSelectedId.current = props.coarse.selectedId;
  }, [props.coarse.selectedId]);
  return (
    <>
      {!primaryPanelOpen && hoverAgent && hoverHit && (
        <Tooltip agent={hoverAgent} hit={hoverHit} />
      )}
      {!props.settingsOpen && selectedAgent && (
        <DetailCard
          agent={selectedAgent}
          hit={selectedHit}
          onClose={() => props.store.select(null)}
        />
      )}
      {!props.settingsOpen && selectedBoard && (
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
            ref={openSettings}
            className="settingsTrigger"
            onClick={props.onOpenSettings}
            aria-label="Open settings"
          >
            Settings
          </button>
        </>
      )}
      <div className="workspaceControls">
        <div className="workspaceScope">
          <select
            ref={workspaceSelect}
            aria-label="Workspace"
            value={props.coarse.selectedWorkspaceId ?? ""}
            onChange={(event) =>
              props.store.selectWorkspace(event.target.value || null)
            }
            onKeyDown={(event) => {
              if (
                event.key === "Tab" &&
                !event.shiftKey &&
                workspaceShowAll.current
              ) {
                event.preventDefault();
                workspaceShowAll.current.focus();
              }
            }}
          >
            <option value="">All</option>
            {catalog.map((item) => (
              <option key={item.id} value={item.id}>
                {workspaceOptionLabel(item.id, item.label, catalog)}
              </option>
            ))}
          </select>
          {props.coarse.blockedElsewhere > 0 && (
            <button
              ref={workspaceShowAll}
              type="button"
              onClick={() => {
                props.store.selectWorkspace(null);
                workspaceSelect.current?.focus();
              }}
            >
              {props.coarse.blockedElsewhere} blocked elsewhere — Show all
            </button>
          )}
        </div>
        <ModeTreatment
          mode={props.coarse.mode}
          sourceStatus={props.coarse.sourceStatus}
          sourceDiagnostic={props.coarse.sourceDiagnostic}
          disconnectReason={props.coarse.disconnectReason}
          lastUpdateSeconds={props.lastUpdateSeconds}
          scopeUnavailableLabel={
            (props.coarse.mode === "live" || props.coarse.mode === "empty") &&
            props.coarse.workspaceUnavailable
              ? workspaceScopeName(props.coarse.selectedWorkspaceLabel)
              : null
          }
          scopeEmptyLabel={
            (props.coarse.mode === "live" || props.coarse.mode === "empty") &&
            props.coarse.selectedWorkspaceId !== null &&
            !props.coarse.workspaceUnavailable &&
            props.coarse.visibleCount === 0
              ? workspaceScopeName(props.coarse.selectedWorkspaceLabel)
              : null
          }
          clearedCount={props.coarse.clearedCount}
          onRevealCleared={props.onRevealCleared}
        />
      </div>
      {import.meta.env.MODE === "visual" && (
        <figure
          className="visualTuiFigure"
          data-expanded={tuiExpanded}
          aria-label="herdr-mise TUI demo recording"
          aria-describedby="tui-demo-description"
        >
          {tuiExpanded && (
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
          )}
          <figcaption>
            Native Ghostty recording of herdr-mise using deterministic demo
            data.
          </figcaption>
          <span id="tui-demo-description" className="visualTuiDescription">
            {tuiDemoDescription}
          </span>
          <div className="visualTuiControls">
            <button
              ref={tuiExpandToggle}
              type="button"
              aria-expanded={tuiExpanded}
              onClick={() => setTuiExpanded(!tuiExpanded)}
            >
              {tuiExpanded ? "Collapse recording" : "Expand recording"}
            </button>
            {tuiExpanded && (
              <button
                type="button"
                onClick={() => {
                  if (tuiStopped) setTuiRestart((value) => value + 1);
                  setTuiStopped(!tuiStopped);
                }}
              >
                {tuiStopped ? "Restart animation" : "Stop animation"}
              </button>
            )}
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
