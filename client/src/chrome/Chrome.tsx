import { useEffect, useRef, useState, type FormEvent } from "react";
import { reducedMotionPreference } from "../runtime";
import { workspaceDisplayName } from "../scene/geometry";
import type { SceneHit } from "../scene/kitchen-scene";
import type { AgentStore, CoarseSlice } from "../state/store";
import {
  parseVisualConfig,
  visualAgentCounts,
  visualPresets,
} from "../visual-harness";
import {
  nextBlockedAgent,
  orderedBlockedAgents,
} from "../state/semantic-stations";
import { DetailCard, SessionSummary, Tooltip } from "./agent-panels";
import { formatDuration } from "./duration";
import { SettingsPanel } from "./settings-panel";
import { useClock } from "./use-clock";
import { ServiceRecap } from "./ServiceRecap";
import {
  ModeTreatment,
  StatsOverlay,
  type DebugMetrics,
} from "./status-panels";

export { DetailCard, SessionSummary, Tooltip } from "./agent-panels";
export { SettingsPanel } from "./settings-panel";
export { ModeTreatment, StatsOverlay } from "./status-panels";
export type { DebugMetrics } from "./status-panels";

function VisualExplorer({ search }: { search: string }) {
  const config = parseVisualConfig(search);
  const [minimized, setMinimized] = useState(false);
  function loadPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      query = new URLSearchParams(location.search);
    query.set("preset", String(form.get("preset")));
    query.set("agents", String(form.get("agents")));
    location.search = query.toString();
  }
  return (
    <aside
      className="visualExplorer"
      aria-label="Preview explorer"
      data-minimized={minimized}
    >
      {!minimized && (
        <p>
          <strong>AI coding agents, at a glance</strong> — a pixel-art kitchen
          for Herdr. Runs locally and read-only; it never controls agents. This
          playground uses deterministic demo data.
        </p>
      )}
      <div className="visualExplorerActions">
        {!minimized && (
          <>
            <a href="https://github.com/funsaized/herdr-mise#quick-start">
              Install for Herdr
            </a>
            <a href="https://github.com/funsaized/herdr-mise">Source</a>
            <button type="button" onClick={() => location.reload()}>
              Replay demo
            </button>
          </>
        )}
        <button
          type="button"
          className="explorerMinimize"
          aria-label={
            minimized ? "Restore introduction" : "Minimize introduction"
          }
          title={minimized ? "Restore introduction" : "Minimize introduction"}
          onClick={() => setMinimized(!minimized)}
        >
          <span aria-hidden="true">{minimized ? "＋" : "–"}</span>
        </button>
      </div>
      {!minimized && (
        <form onSubmit={loadPreview}>
          <label>
            Scene
            <select name="preset" defaultValue={config.preset}>
              {visualPresets.map((preset) => (
                <option key={preset}>{preset}</option>
              ))}
            </select>
          </label>
          <label>
            Cooks
            <select name="agents" defaultValue={config.agents}>
              {!visualAgentCounts.some((count) => count === config.agents) && (
                <option value={config.agents}>
                  {config.agents} — URL roster
                </option>
              )}
              {visualAgentCounts.map((count) => (
                <option key={count} value={count}>
                  {count === 0
                    ? "0 — Clear service"
                    : count === 12
                      ? "12 — Large herd"
                      : count}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            aria-describedby="visual-explorer-reset"
            title="Loading a scene resets this preview."
          >
            Load preview
          </button>
          <span id="visual-explorer-reset" className="visuallyHidden">
            Loading a scene resets this preview.
          </span>
        </form>
      )}
    </aside>
  );
}

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
  notificationDeliveryFailed?: boolean;
  statsOpen: boolean;
  lastUpdateSeconds: number;
  metrics: DebugMetrics;
  onCloseSettings(): void;
  onOpenSettings(): void;
  onDismissHint(): void;
  hintVisible: boolean;
  view: "kitchen" | "freezer";
  onToggleFreezer(): void;
  onNextBlocked(): void;
  onRevealCleared(): void;
}

export function Chrome(props: ChromeProps) {
  const [tuiStopped, setTuiStopped] = useState(() =>
      reducedMotionPreference.current(),
    ),
    [tuiExpanded, setTuiExpanded] = useState(false),
    [tuiRestart, setTuiRestart] = useState(0),
    tuiExpandToggle = useRef<HTMLButtonElement>(null),
    now = useClock(props.coarse.blocked > 0),
    workspaceSelect = useRef<HTMLSelectElement>(null),
    workspaceShowAll = useRef<HTMLButtonElement>(null);
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
      : undefined,
    blocked = orderedBlockedAgents([...snapshot.visibleAgents.values()]),
    nextBlocked = nextBlockedAgent(blocked, props.focusedId),
    oldestBlocked = blocked.find((agent) =>
      Number.isFinite(Date.parse(agent.stateEnteredAt)),
    );
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
  const settingsStation = useRef<string | null>(null);
  useEffect(() => {
    if (selectedAgent) settingsStation.current = selectedAgent.id;
  }, [selectedAgent]);
  useEffect(() => {
    if (!primaryPanelOpen || !tuiExpanded) return;
    const frame = requestAnimationFrame(() => setTuiExpanded(false));
    return () => cancelAnimationFrame(frame);
  }, [primaryPanelOpen, tuiExpanded]);
  return (
    <>
      {!primaryPanelOpen && hoverAgent && hoverHit && (
        <Tooltip agent={hoverAgent} hit={hoverHit} />
      )}
      {!props.settingsOpen && selectedAgent && props.view !== "freezer" && (
        <DetailCard
          agent={selectedAgent}
          hit={selectedHit}
          onClose={() => props.store.select(null)}
        />
      )}
      {!props.settingsOpen &&
        selectedBoard &&
        (props.view === "freezer" || !selectedAgent) && (
          <SessionSummary
            entry={selectedBoard}
            hit={props.hits.find((hit) => hit.id === selectedBoard.id)}
            onClose={() => props.store.select(null)}
          />
        )}
      {props.settingsOpen && (
        <SettingsPanel
          avoid={() =>
            props.hits.find((hit) => hit.id === settingsStation.current)
              ?.rect ?? null
          }
          settings={props.coarse.settings}
          notificationDeliveryFailed={props.notificationDeliveryFailed}
          onChange={(patch) => props.store.setSettings(patch)}
          onClose={props.onCloseSettings}
        />
      )}
      <div className="chromeRail">
        <section className="serviceStrip" aria-label="Observed service summary">
          <span
            className={
              props.coarse.blocked === 0 ? "chromeCountEmpty" : "blockedCount"
            }
          >
            <strong>Blocked:</strong> {props.coarse.blocked}
          </span>
          <span
            className={oldestBlocked ? "oldestBlocked" : "chromeCountEmpty"}
          >
            <strong>Oldest blocked:</strong> {oldestBlocked?.name ?? "None"}
            {oldestBlocked
              ? ` · ${formatDuration(now - Date.parse(oldestBlocked.stateEnteredAt))}`
              : ""}
          </span>
          {nextBlocked ? (
            <button
              type="button"
              disabled={props.view === "freezer" || !nextBlocked}
              aria-label={
                nextBlocked
                  ? `Next blocked: ${nextBlocked.name}`
                  : "Next blocked: none"
              }
              title="Next blocked (B)"
              onClick={props.onNextBlocked}
            >
              <span className="desktopLabel">Next blocked</span>
              <span className="phoneLabel" aria-hidden="true">
                Next
              </span>
            </button>
          ) : (
            <span className="quietService">
              All quiet
              {props.coarse.blockedElsewhere > 0 && (
                // Phones show the "+N" badge on the scope control instead.
                <span className="desktopLabel">
                  {" "}
                  in this workspace — blocked work elsewhere
                </span>
              )}
            </span>
          )}
          {(
            [
              ["Working", props.coarse.working],
              ["Plated", props.coarse.plated],
              ["Unknown", props.coarse.unknown],
            ] as const
          ).map(([label, count]) => (
            <span
              key={label}
              className={count === 0 ? "chromeCountEmpty" : "chromeCount"}
              data-count={label.toLowerCase()}
            >
              <strong>{label}:</strong> {count}
            </span>
          ))}
        </section>
        <div className="chromeFooter">
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
                  className="scopeElsewhere"
                  aria-label={`${props.coarse.blockedElsewhere} blocked elsewhere — Show all`}
                  onClick={() => {
                    props.store.selectWorkspace(null);
                    workspaceSelect.current?.focus();
                  }}
                >
                  <span className="desktopLabel">
                    {props.coarse.blockedElsewhere} blocked elsewhere — Show all
                  </span>
                  <span className="phoneLabel" aria-hidden="true">
                    +{props.coarse.blockedElsewhere}
                  </span>
                </button>
              )}
              {props.coarse.visible < props.coarse.count && (
                <span className="scopeQualifier">
                  <strong>Shown:</strong> {props.coarse.visible} of{" "}
                  {props.coarse.count}
                </span>
              )}
              {props.coarse.hiddenDone > 0 && (
                <span className="scopeQualifier">
                  <strong>Hidden plated:</strong> {props.coarse.hiddenDone}
                </span>
              )}
              {(props.coarse.visible < props.coarse.count ||
                props.coarse.hiddenDone > 0) && (
                <span
                  className="phoneLabel scopeBadge"
                  title={`Shown: ${props.coarse.visible} of ${props.coarse.count}; Hidden plated: ${props.coarse.hiddenDone}`}
                  aria-hidden="true"
                >
                  ·
                </span>
              )}
            </div>
          </div>
          <div className="chromeTools">
            <button
              className="settingsTrigger freezerTrigger"
              onClick={props.onToggleFreezer}
              aria-pressed={props.view === "freezer"}
            >
              Freezer
            </button>
            <ServiceRecap store={props.store} coarse={props.coarse} />
            <button
              className="settingsTrigger"
              onClick={props.onOpenSettings}
              aria-label="Open settings"
            >
              <span className="desktopLabel">Settings</span>
              <span className="phoneLabel" aria-hidden="true">
                ⚙
              </span>
            </button>
            {import.meta.env.MODE === "visual" && (
              <button
                ref={tuiExpandToggle}
                type="button"
                // Label in Name: the accessible name matches the visible
                // "Terminal view" text (phones show only the >_ glyph).
                aria-label="Terminal view"
                aria-expanded={tuiExpanded}
                onClick={() => setTuiExpanded(!tuiExpanded)}
              >
                <span className="desktopLabel">Terminal view</span>
                <span className="phoneLabel" aria-hidden="true">
                  &gt;_
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="workspaceControls modeControls">
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
          intentionalPreview={import.meta.env.MODE === "visual"}
        />
      </div>
      {import.meta.env.MODE === "visual" && (
        <>
          {!primaryPanelOpen && <VisualExplorer search={location.search} />}
          {tuiExpanded && (
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
                  type="button"
                  aria-expanded={tuiExpanded}
                  onClick={() => {
                    setTuiExpanded(false);
                    tuiExpandToggle.current?.focus();
                  }}
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
        </>
      )}
      {/* While Herdr is unreachable or incompatible, the demo placard
          carries the connection steps; the floating hint would repeat them
          and crowd the placard on small screens. */}
      {props.hintVisible &&
        !(
          props.coarse.mode === "demo" &&
          props.coarse.sourceStatus !== "connected" &&
          import.meta.env.MODE !== "visual"
        ) && (
          <div className="firstHint" role="note">
            Blocked cooks ring the service bell.{" "}
            <button onClick={props.onDismissHint}>Got it</button>
          </div>
        )}
      {props.statsOpen && <StatsOverlay metrics={props.metrics} />}
    </>
  );
}
