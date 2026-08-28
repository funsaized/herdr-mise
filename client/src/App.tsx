import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Chrome, type DebugMetrics } from "./chrome/Chrome";
import { KitchenScene, type SceneHit } from "./scene/kitchen-scene";
import type { CoarseSlice } from "./state/store";
import { AgentWebSocketClient } from "./state/ws-client";
import { tokens } from "./theme/tokens";
import { clientStore, hintPersistence } from "./runtime";
import { isGlobalEscape, isInteractiveKeyboardTarget } from "./keyboard";
import {
  semanticAgents,
  semanticAgentsEqual,
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
} as CSSProperties;
const initialMetrics: DebugMetrics = { drawCalls: 0, socketBytesPerSecond: 0 };
export function App() {
  const host = useRef<HTMLDivElement>(null),
    sceneRef = useRef<KitchenScene | null>(null),
    socketRef = useRef<AgentWebSocketClient | null>(null);
  const semanticRestoreRef = useRef<HTMLButtonElement | null>(null),
    settingsRestorePendingRef = useRef(false);
  const [coarse, setCoarse] = useState<CoarseSlice>(() => clientStore.coarse()),
    [agents, setAgents] = useState<readonly SemanticAgent[]>(() =>
      semanticAgents(clientStore.snapshot().agents),
    ),
    [hits, setHits] = useState<readonly SceneHit[]>([]),
    [hoveredId, setHoveredId] = useState<string | null>(null),
    [focusedId, setFocusedId] = useState<string | null>(null),
    [settingsOpen, setSettingsOpen] = useState(false),
    [statsOpen, setStatsOpen] = useState(() =>
      new URLSearchParams(location.search).has("stats"),
    ),
    [lastUpdateSeconds, setLastUpdateSeconds] = useState(0),
    [metrics, setMetrics] = useState<DebugMetrics>(initialMetrics),
    [announcement, setAnnouncement] = useState(""),
    [hintVisible, setHintVisible] = useState(() => hintPersistence.isVisible());
  useEffect(() => clientStore.subscribeCoarse(setCoarse), []);
  useEffect(
    () =>
      clientStore.subscribe(() =>
        setAgents((previous) => {
          const next = semanticAgents(clientStore.snapshot().agents);
          return semanticAgentsEqual(previous, next) ? previous : next;
        }),
      ),
    [],
  );
  useEffect(
    () =>
      clientStore.onEvent((event) => {
        if (event.type !== "state" || event.from === undefined) return;
        const agent = clientStore.snapshot().agents.get(event.agentId);
        if (agent)
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
    });
    sceneRef.current = scene;
    if (new URLSearchParams(location.search).has("stats"))
      Object.defineProperty(window, "__miseSceneMetrics", {
        configurable: true,
        value: () => scene.metrics(),
      });
    void scene.init();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:",
      socket = new AgentWebSocketClient(
        `${protocol}//${location.host}/ws`,
        clientStore,
      );
    socketRef.current = socket;
    socket.start();
    return () => {
      socket.stop();
      scene.destroy();
      delete (window as Window & { __miseSceneMetrics?: unknown })
        .__miseSceneMetrics;
      sceneRef.current = null;
      socketRef.current = null;
    };
  }, []);
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
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (isGlobalEscape(event)) {
        setSettingsOpen(false);
        clientStore.select(null);
        return;
      }
      if (isInteractiveKeyboardTarget(event.target)) return;
      if (event.key.toLowerCase() === "s" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setStatsOpen((value) => !value);
        return;
      }
      const stationIds = hits
        .filter((hit) => hit.kind === "station")
        .map((hit) => hit.id);
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
          index = Math.max(0, stationIds.indexOf(focusedId ?? "")),
          next =
            stationIds[
              (index + direction + stationIds.length) % stationIds.length
            ]!;
        setFocusedId(next);
        sceneRef.current?.focus(next);
        return;
      }
      if (event.key === "Enter" && focusedId) {
        semanticRestoreRef.current = null;
        clientStore.select(focusedId);
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [focusedId, hits]);
  useEffect(() => {
    if (coarse.selectedId === null && semanticRestoreRef.current) {
      semanticRestoreRef.current.focus();
      semanticRestoreRef.current = null;
    }
  }, [coarse.selectedId]);
  useEffect(() => {
    if (!settingsOpen && settingsRestorePendingRef.current) {
      document.querySelector<HTMLButtonElement>(".settingsTrigger")?.focus();
      settingsRestorePendingRef.current = false;
    }
  }, [settingsOpen]);
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect(),
      hit = sceneRef.current?.hitTest(
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      );
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
  const canvasClass = `canvasHost${settingsOpen ? " dimmed" : ""}${coarse.mode === "disconnected" ? " disconnected" : ""}`;
  return (
    <main className="appShell" style={cssTokens}>
      <div
        ref={host}
        className={canvasClass}
        aria-label="Agent state kitchen scene"
        onPointerDown={() => {
          semanticRestoreRef.current = null;
        }}
        onPointerMove={pointerMove}
        onPointerLeave={() => setHoveredId(null)}
      />
      <SemanticStationControls
        agents={agents}
        onSelect={(id, element) => {
          semanticRestoreRef.current = element;
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
        />
      </div>
      <div
        className="liveRegion"
        aria-label="Agent state announcements"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
    </main>
  );
}
