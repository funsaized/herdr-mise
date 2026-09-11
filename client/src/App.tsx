import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Chrome, type DebugMetrics } from "./chrome/Chrome";
import {
  KitchenScene,
  type PageMetadata,
  type SceneHit,
} from "./scene/kitchen-scene";
import { workspaceDisplayName } from "./scene/geometry";
import type { CoarseSlice } from "./state/store";
import { AgentWebSocketClient } from "./state/ws-client";
import { tokens } from "./theme/tokens";
import { clientStore, hintPersistence } from "./runtime";
import { isGlobalEscape, isInteractiveKeyboardTarget } from "./keyboard";
import {
  freezerAnnouncement,
  semanticAgents,
  semanticAgentsEqual,
  nextBlockedAgent,
  semanticStateWords,
  type SemanticAgent,
} from "./state/semantic-stations";
import { SemanticStationControls } from "./chrome/SemanticStationControls";

const cssTokens = {
  "--panel": tokens.chrome.panel,
  "--panelSoft": tokens.chrome.panelSoft,
  "--border": tokens.chrome.border,
  "--borderSoft": tokens.chrome.borderSoft,
  "--hairline": tokens.chrome.hairline[0],
  "--hairline2": tokens.chrome.hairline[1],
  "--text": tokens.chrome.text,
  "--textWarm": tokens.chrome.textWarm,
  "--textMuted": tokens.chrome.textMuted,
  "--workingText": tokens.chrome.workingText,
  "--doneText": tokens.chrome.doneText,
  "--secondary": tokens.chrome.secondary,
  "--tertiary": tokens.chrome.tertiary,
  "--tooltipSecondary": tokens.chrome.tooltipSecondary,
  "--chip": tokens.chrome.chip,
  "--buttonText": tokens.chrome.buttonText,
  "--white": tokens.chrome.white,
  "--toggleOff": tokens.chrome.toggleOff,
  "--amber": tokens.chrome.amber,
  "--tooltip": tokens.chrome.tooltip,
  "--scrim": tokens.chrome.scrim,
  "--shadow": tokens.chrome.shadow,
  "--shadowStrong": tokens.chrome.shadowStrong,
  "--shadowPlacard": tokens.chrome.shadowPlacard,
  "--shadowKnob": tokens.chrome.shadow,
  "--shadowSmall": tokens.chrome.shadow,
  "--focus": tokens.semantic.flameHighDark,
  "--ticketDone": tokens.scene.ticketDone,
  "--flame": tokens.semantic.flame,
  "--done": tokens.semantic.done,
  "--tungsten": tokens.semantic.tungsten,
  "--spacePanel": `${tokens.spacing.panel}px`,
  "--spaceRowSmall": `${tokens.spacing.rowSmall}px`,
  "--spaceRow": `${tokens.spacing.row}px`,
  "--radiusSmall": `${tokens.radius.small}px`,
  "--radiusTooltip": `${tokens.radius.tooltip}px`,
  "--radiusControl": `${tokens.radius.control}px`,
  "--radiusPanel": `${tokens.radius.panel}px`,
  "--fontWorld": tokens.typography.worldFamily,
  "--fontChrome": tokens.typography.chromeFamily,
  "--fontTitleSize": `${tokens.typography.title.size}px`,
  "--fontTitleWeight": tokens.typography.title.weight,
  "--fontRowLabelSize": `${tokens.typography.rowLabel.size}px`,
  "--fontRowLabelWeight": tokens.typography.rowLabel.weight,
  "--fontValueSize": `${tokens.typography.value.size}px`,
  "--fontValueWeight": tokens.typography.value.weight,
  "--fontSecondarySize": `${tokens.typography.secondary.size}px`,
  "--fontSecondaryWeight": tokens.typography.secondary.weight,
  "--fontSectionSize": `${tokens.typography.section.size}px`,
  "--fontSectionWeight": tokens.typography.section.weight,
  "--fontNumericVariant": tokens.typography.numericVariant,
  "--pagerReservedHeight": `${tokens.scene.layout.pagerReservedHeight}px`,
  "--compactPagerReservedHeight": `${tokens.scene.layout.compactPagerReservedHeight}px`,
} as CSSProperties;
const initialMetrics: DebugMetrics = { drawCalls: 0, socketBytesPerSecond: 0 };
const initialPage: PageMetadata = {
  totalCount: 0,
  visibleCount: 0,
  capacity: 1,
  pageIndex: 0,
  pageCount: 1,
  pagerLayout: "standard",
};

function semanticStationButton(id: string) {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".stationA11yMirror button",
    ),
  ].find((button) => button.dataset.agentId === id);
}

export function App() {
  const host = useRef<HTMLDivElement>(null),
    sceneRef = useRef<KitchenScene | null>(null),
    socketRef = useRef<AgentWebSocketClient | null>(null);
  const semanticRestoreRef = useRef<HTMLButtonElement | null>(null),
    settingsRestorePendingRef = useRef(false),
    selectedLocationRef = useRef<Pick<
      SemanticAgent,
      "id" | "name" | "paneId" | "workspace"
    > | null>(null),
    pageRef = useRef<PageMetadata>(initialPage);
  const [coarse, setCoarse] = useState<CoarseSlice>(() => clientStore.coarse()),
    [agents, setAgents] = useState<readonly SemanticAgent[]>(() =>
      semanticAgents(clientStore.snapshot().visibleAgents),
    ),
    [hits, setHits] = useState<readonly SceneHit[]>([]),
    [page, setPage] = useState<PageMetadata>(initialPage),
    [hoveredId, setHoveredId] = useState<string | null>(null),
    [focusedId, setFocusedId] = useState<string | null>(null),
    [view, setView] = useState<"kitchen" | "freezer">("kitchen"),
    [settingsOpen, setSettingsOpen] = useState(false),
    [statsOpen, setStatsOpen] = useState(() =>
      new URLSearchParams(location.search).has("stats"),
    ),
    [lastUpdateSeconds, setLastUpdateSeconds] = useState(0),
    [metrics, setMetrics] = useState<DebugMetrics>(initialMetrics),
    [announcement, setAnnouncement] = useState(""),
    [hintVisible, setHintVisible] = useState(() => hintPersistence.isVisible());
  const [rendererFailed, setRendererFailed] = useState(false);
  useEffect(() => clientStore.subscribeCoarse(setCoarse), []);
  useEffect(
    () =>
      clientStore.subscribe(() =>
        setAgents((previous) => {
          const next = semanticAgents(clientStore.snapshot().visibleAgents);
          return semanticAgentsEqual(previous, next) ? previous : next;
        }),
      ),
    [],
  );
  useEffect(() => {
    const selected = agents.find((agent) => agent.id === coarse.selectedId),
      previous = selectedLocationRef.current;
    selectedLocationRef.current = selected ?? null;
    if (
      selected &&
      previous?.id === selected.id &&
      (previous.paneId !== selected.paneId ||
        previous.workspace !== selected.workspace)
    )
      setAnnouncement(
        `${selected.name} moved to ${workspaceDisplayName(selected.workspace)}${selected.paneId ? `, pane ${selected.paneId}` : ""}`,
      );
  }, [agents, coarse.selectedId]);
  useEffect(
    () =>
      clientStore.onEvent((event) => {
        if (event.type === "reveal") {
          setAnnouncement(
            `${event.count} plated cook${event.count === 1 ? "" : "s"} revealed`,
          );
          return;
        }
        if (event.type !== "busser" && event.type !== "state") return;
        const agent = clientStore.snapshot().agents.get(event.agentId);
        if (event.type === "busser" && agent) {
          setAnnouncement(`${agent.name} cleared from the kitchen`);
          return;
        }
        if (event.type === "state" && event.from !== undefined && agent)
          setAnnouncement(
            `${agent.name} ${event.to}${event.to === "blocked" ? ", just now" : ""}`,
          );
      }),
    [],
  );
  useEffect(() => {
    if (!host.current) return;
    const scene = new KitchenScene(clientStore, host.current, {
      onHitLayout: setHits,
      onPageLayout: (next) => {
        if (
          pageRef.current.totalCount > 0 &&
          pageRef.current.pageIndex !== next.pageIndex
        )
          setAnnouncement(
            `Kitchen page ${next.pageIndex + 1} of ${next.pageCount}, ${next.visibleCount} of ${next.totalCount} cooks shown`,
          );
        pageRef.current = next;
        setPage(next);
      },
    });
    sceneRef.current = scene;
    if (new URLSearchParams(location.search).has("stats"))
      Object.defineProperty(window, "__miseSceneMetrics", {
        configurable: true,
        value: () => scene.metrics(),
      });
    let mounted = true;
    void scene.init().catch(() => {
      if (mounted) setRendererFailed(true);
    });
    const protocol = location.protocol === "https:" ? "wss:" : "ws:",
      socket = new AgentWebSocketClient(
        `${protocol}//${location.host}/ws?paneId=1`,
        clientStore,
      );
    socketRef.current = socket;
    socket.start();
    return () => {
      mounted = false;
      socket.stop();
      scene.destroy();
      delete (window as Window & { __miseSceneMetrics?: unknown })
        .__miseSceneMetrics;
      sceneRef.current = null;
      socketRef.current = null;
    };
  }, []);
  useEffect(() => {
    sceneRef.current?.setView(view);
  }, [view]);
  useEffect(() => {
    if (coarse.mode !== "disconnected") return;
    const timer = window.setInterval(
      () => setLastUpdateSeconds(clientStore.lastUpdateSeconds()),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [coarse.mode]);
  useEffect(() => {
    if (!statsOpen) return;
    const timer = window.setInterval(() => {
      const scene = sceneRef.current?.metrics();
      setMetrics({
        drawCalls: scene?.drawCalls ?? 0,
        socketBytesPerSecond: socketRef.current?.bytesPerSecond() ?? 0,
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [statsOpen]);
  const boardEntries = clientStore.snapshot().board,
    renderedIds = new Set(
      hits.filter((hit) => hit.kind === "station").map((hit) => hit.id),
    ),
    stationHitById = new Map(
      hits
        .filter((hit) => hit.kind === "station")
        .map((hit) => [hit.id, hit] as const),
    ),
    stationOrder = new Map(
      hits
        .filter((hit) => hit.kind === "station")
        .map((hit, index) => [hit.id, index]),
    ),
    agentIds = new Set(agents.map((agent) => agent.id)),
    blockedAgents = agents.filter((agent) => agent.targetState === "blocked"),
    visibleBlocked = blockedAgents.filter((agent) =>
      renderedIds.has(agent.id),
    ).length,
    spiritAgents = hits
      .filter((hit) => hit.kind === "spirit")
      .flatMap((hit) => {
        const entry = boardEntries.find((item) => item.id === hit.id);
        return entry
          ? [
              {
                id: entry.id,
                name: entry.name,
                workspace: "",
                targetState: "ended" as const,
                stateEnteredAt: new Date(entry.endedAt).toISOString(),
              },
            ]
          : [];
      }),
    kitchenControls = [
      ...(page.pageCount === 1
        ? [...agents].sort(
            (left, right) =>
              (stationOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
              (stationOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
          )
        : agents
      ).map((agent) => {
        const hit = stationHitById.get(agent.id);
        return hit
          ? { ...agent, blockedPlacement: hit.blockedPlacement }
          : agent;
      }),
      ...hits
        .filter((hit) => hit.kind === "board")
        .flatMap((hit) => {
          if (agentIds.has(hit.id)) return [];
          const entry = boardEntries.find((item) => item.id === hit.id);
          return entry
            ? [
                {
                  id: entry.id,
                  name: entry.name,
                  workspace: "",
                  targetState: "ended" as const,
                  stateEnteredAt: new Date(entry.endedAt).toISOString(),
                },
              ]
            : [];
        }),
    ],
    controls = view === "freezer" ? spiritAgents : kitchenControls,
    tooltipAgentIdCandidate =
      !settingsOpen && coarse.selectedId === null
        ? (hoveredId ?? focusedId)
        : null,
    tooltipAgentId = hits.some(
      (hit) => hit.kind === "station" && hit.id === tooltipAgentIdCandidate,
    )
      ? tooltipAgentIdCandidate
      : null;
  const focusState = useRef({ controls, agents, focusedId });
  useLayoutEffect(() => {
    focusState.current = { controls, agents, focusedId };
  }, [agents, controls, focusedId]);
  const focusSemantic = useCallback((id: string) => {
      setFocusedId(id);
      sceneRef.current?.focus(id);
      const index = focusState.current.controls.findIndex(
        (control) => control.id === id,
      );
      document
        .querySelectorAll<HTMLButtonElement>(".stationA11yMirror button")
        [index]?.focus();
    }, []),
    nextBlocked = useCallback(() => {
      if (view === "freezer") return;
      const { agents, focusedId } = focusState.current,
        next = nextBlockedAgent(agents, focusedId ?? coarse.selectedId);
      if (next) focusSemantic(next.id);
    }, [coarse.selectedId, focusSemantic, view]);
  useLayoutEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (isGlobalEscape(event)) {
        if (settingsOpen) setSettingsOpen(false);
        else if (coarse.selectedId) clientStore.select(null);
        else if (view === "freezer") {
          setView("kitchen");
          setAnnouncement("Kitchen");
        }
        return;
      }
      const semanticNav =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(".stationA11yMirror")
          : null;
      if (isInteractiveKeyboardTarget(event.target) && !semanticNav) return;
      if (event.key === "Tab" && semanticNav) {
        event.preventDefault();
        document
          .querySelector<HTMLButtonElement>(
            event.shiftKey
              ? ".settingsTrigger.freezerTrigger"
              : ".settingsTrigger:not(.freezerTrigger)",
          )
          ?.focus();
        return;
      }
      if (event.key.toLowerCase() === "s" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setStatsOpen((value) => !value);
        return;
      }
      if (event.key.toLowerCase() === "b" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        nextBlocked();
        return;
      }
      const stationIds = controls.map((agent) => agent.id);
      if (!stationIds.length) return;
      if (
        ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(
          event.key,
        ) ||
        (event.key === "Tab" && event.target === document.body)
      ) {
        event.preventDefault();
        const direction =
            event.key === "ArrowLeft" ||
            event.key === "ArrowUp" ||
            event.shiftKey
              ? -1
              : 1,
          currentId =
            event.target instanceof Element
              ? event.target.closest<HTMLButtonElement>("button")?.dataset
                  .agentId
              : undefined,
          index = currentId ? stationIds.indexOf(currentId) : -1,
          nextIndex =
            index < 0
              ? direction > 0
                ? 0
                : stationIds.length - 1
              : (index + direction + stationIds.length) % stationIds.length,
          next = stationIds[nextIndex]!;
        focusSemantic(next);
        return;
      }
      if (event.key === "Enter" && focusedId) {
        // Native semantic buttons own activation and remember their trigger.
        // Handling Enter here as well clears it before Chrome/WebKit click.
        if (semanticNav) return;
        semanticRestoreRef.current = null;
        clientStore.select(focusedId);
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [
    coarse.selectedId,
    controls,
    focusSemantic,
    focusedId,
    nextBlocked,
    settingsOpen,
    view,
  ]);
  useEffect(() => {
    if (coarse.selectedId === null && semanticRestoreRef.current) {
      semanticRestoreRef.current.focus();
      semanticRestoreRef.current = null;
    }
  }, [coarse.selectedId]);
  useEffect(() => {
    if (!settingsOpen && settingsRestorePendingRef.current) {
      document
        .querySelector<HTMLButtonElement>(
          ".settingsTrigger:not(.freezerTrigger)",
        )
        ?.focus();
      settingsRestorePendingRef.current = false;
    }
  }, [settingsOpen]);
  const pointerHit = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect(),
      hit = sceneRef.current?.hitTest(
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      );
    return hit;
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const hit = pointerHit(event);
    setHoveredId(hit?.kind === "station" ? hit.id : null);
  };
  const dismissHint = () => {
    hintPersistence.dismiss();
    setHintVisible(false);
  };
  const openSettings = () => {
    settingsRestorePendingRef.current = true;
    setSettingsOpen(true);
  };
  const toggleFreezer = () => {
    const next = view === "kitchen" ? "freezer" : "kitchen";
    if (next === "freezer" && coarse.selectedId) clientStore.select(null);
    setFocusedId(null);
    sceneRef.current?.focus(null);
    setView(next);
    if (next === "kitchen") setAnnouncement("Kitchen");
  };
  const canvasClass = `canvasHost${settingsOpen ? " dimmed" : ""}${coarse.mode === "disconnected" ? " disconnected" : ""}`;
  return (
    <main
      className="appShell"
      data-pager-layout={page.pagerLayout}
      style={cssTokens}
    >
      {rendererFailed && (
        <section className="rendererFallback" aria-label="Agent status list">
          <p role="alert">
            The kitchen graphics could not start. Agent status is available
            below. Reload to retry graphics.
          </p>
          <ul>
            {agents.map((agent) => (
              <li key={agent.id}>
                <button
                  onClick={(event) => {
                    semanticRestoreRef.current = event.currentTarget;
                    clientStore.select(agent.id);
                  }}
                >
                  {agent.name}: {semanticStateWords(agent)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div
        ref={host}
        className={canvasClass}
        aria-label={`Agent state ${view} scene`}
        onPointerDown={(event) => {
          const hit = pointerHit(event);
          semanticRestoreRef.current = hit
            ? (semanticStationButton(hit.id) ?? null)
            : null;
          if (hit) {
            focusSemantic(hit.id);
          }
        }}
        onPointerMove={pointerMove}
        onPointerLeave={() => setHoveredId(null)}
      />
      <SemanticStationControls
        agents={controls}
        label={view === "freezer" ? "Ended chefs" : undefined}
        tooltipAgentId={tooltipAgentId}
        page={view === "kitchen" ? page : undefined}
        blockedTotal={blockedAgents.length}
        blockedVisible={visibleBlocked}
        onPreviousPage={() => sceneRef.current?.previousPage()}
        onNextPage={() => sceneRef.current?.nextPage()}
        onNextBlocked={nextBlocked}
        onSelect={(id, element) => {
          semanticRestoreRef.current = element;
          setFocusedId(id);
          sceneRef.current?.focus(id);
          clientStore.select(id);
        }}
      />
      <div className="chromeLayer">
        <Chrome
          store={clientStore}
          coarse={coarse}
          hoveredId={hoveredId}
          focusedId={focusedId}
          hits={hits}
          settingsOpen={settingsOpen}
          statsOpen={statsOpen}
          lastUpdateSeconds={lastUpdateSeconds}
          metrics={metrics}
          onCloseSettings={() => setSettingsOpen(false)}
          onOpenSettings={openSettings}
          hintVisible={hintVisible}
          onDismissHint={dismissHint}
          view={view}
          onToggleFreezer={toggleFreezer}
          onNextBlocked={nextBlocked}
          onRevealCleared={() => clientStore.revealCleared()}
        />
      </div>
      <div
        className="liveRegion"
        aria-label="Agent state announcements"
        aria-live="polite"
        aria-atomic="true"
      >
        {view === "freezer"
          ? freezerAnnouncement(spiritAgents.length, boardEntries.length)
          : announcement}
      </div>
    </main>
  );
}
