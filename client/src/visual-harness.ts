import type { AgentRecord, AgentState, AgentStateEvent } from "../../protocol/generated/agent-state-event";
import type { ThemeChoice } from "./theme/theme";

export type VisualPreset = AgentState | "mixed";
export type VisualAgentCount = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
export interface VisualConfig { preset: VisualPreset; agents: VisualAgentCount; theme: ThemeChoice }

const presets = new Set<VisualPreset>(["idle", "working", "blocked", "done", "ended", "mixed"]);
export const defaultVisualConfig: VisualConfig = { preset: "mixed", agents: 6, theme: "light" };

export function isVisualMode(mode: string) { return mode === "visual"; }

export function parseVisualConfig(search: string): VisualConfig {
  const query = new URLSearchParams(search), preset = query.get("preset"), count = Number(query.get("agents"));
  return {
    preset: preset !== null && presets.has(preset as VisualPreset) ? preset as VisualPreset : defaultVisualConfig.preset,
    agents: Number.isInteger(count) && count >= 1 && count <= 12 ? count as VisualAgentCount : defaultVisualConfig.agents,
    theme: query.get("theme") === "dinner" ? "dark" : "light",
  };
}

const stateAgeMs: Record<Exclude<AgentState, "ended">, number> = { idle: 12_000, working: 18_000, blocked: 45_000, done: 8_000 };
const identities = [
  ["Codex", "gpt-5.3-codex", "checkout-api"], ["Claude", "claude-sonnet-4", "payments"],
  ["Hermes", "hermes-4", "order-routing"], ["OpenClaw", "openclaw-2", "kitchen-ui"],
  ["Gemini", "gemini-2.5-pro", "inventory"], ["Aider", "deepseek-v3", "receipts"],
] as const;
const mixedStates = ["working", "blocked", "idle", "done", "working", "blocked"] as const;
function agent(index: number, state: Exclude<AgentState, "ended">, now: number, mixed = false): AgentRecord {
  const identity = identities[index % identities.length]!;
  const cycle = Math.floor(index / identities.length) + 1;
  const mixedSuffix = cycle > 1 ? `-${cycle}` : "";
  const progress = state === "working" ? (mixed ? (index + 2) / 14 : (index + 1) / 13) : null;
  return { id: `visual-agent-${index + 1}`, name: mixed ? `${identity[0]}${mixedSuffix}` : `mise-${String(index + 1).padStart(2, "0")}`, state, progress, stateEnteredAt: new Date(now - stateAgeMs[state] - (mixed ? index * 7_000 : 0)).toISOString(), accentIndex: index % 12, model: mixed ? identity[1] : "codex", workspace: mixed ? `/service/${identity[2]}${mixedSuffix}` : `/visual/station-${index + 1}`, session: { runtimeMs: (index + 1) * 60_000, tickets: index + 1 } };
}

export function buildVisualFeed(config: VisualConfig, now = Date.now()): AgentStateEvent[] {
  const mixed = config.preset === "mixed";
  const initialState = config.preset === "ended" ? "done" : config.preset === "mixed" ? "working" : config.preset;
  const agents = Array.from({ length: config.agents }, (_, index) => agent(index, mixed ? mixedStates[index % mixedStates.length]! : initialState, now, mixed));
  const snapshot: AgentStateEvent = { version: 1, type: "snapshot", mode: "demo", agents };
  if (config.preset !== "ended") return [snapshot];
  return [snapshot, ...agents.map(record => ({ version: 1 as const, type: "delta" as const, mode: "demo" as const, operation: "upsert" as const, agent: { ...record, state: "ended" as const } }))];
}

interface WebSocketTarget { WebSocket?: typeof WebSocket }

export function installVisualWebSocket(target: WebSocketTarget, config: VisualConfig) {
  const feed = buildVisualFeed(config);
  const heartbeat: AgentStateEvent = { version: 1, type: "heartbeat" };
  const NativeWebSocket = target.WebSocket;
  class VisualWebSocket {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
    readonly url = ""; readyState = VisualWebSocket.CONNECTING;
    onopen: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
    private heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
    private lifecycleTimers: Array<ReturnType<typeof globalThis.setTimeout>> = [];
    constructor(url: string | URL, protocols?: string | string[]) {
      const value = String(url), base = typeof location === "undefined" ? "http://visual.invalid" : location.origin;
      if (new URL(value, base).pathname !== "/ws" && NativeWebSocket) return new NativeWebSocket(url, protocols) as unknown as VisualWebSocket;
      Object.defineProperty(this, "url", { value }); queueMicrotask(() => { if (this.readyState !== VisualWebSocket.CONNECTING) return; this.readyState = VisualWebSocket.OPEN; this.onopen?.(); for (const event of feed) this.onmessage?.({ data: JSON.stringify(event) }); this.scheduleMixedLifecycle(); this.heartbeatTimer = globalThis.setInterval(() => { if (this.readyState === VisualWebSocket.OPEN) this.onmessage?.({ data: JSON.stringify(heartbeat) }); }, 2_000); });
    }
    close() { if (this.readyState === VisualWebSocket.CLOSED) return; this.readyState = VisualWebSocket.CLOSED; if (this.heartbeatTimer !== null) globalThis.clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; for (const timer of this.lifecycleTimers) globalThis.clearTimeout(timer); this.lifecycleTimers = []; this.onclose?.(); }
    private scheduleMixedLifecycle() {
      if (config.preset !== "mixed") return;
      const snapshot = feed[0], hero = snapshot?.type === "snapshot" ? snapshot.agents[0] : undefined;
      if (!hero) return;
      const phases = [
        { delay: 5_000, state: "blocked" as const, progress: null },
        { delay: 7_000, state: "working" as const, progress: 0.78 },
        { delay: 9_500, state: "done" as const, progress: null },
      ];
      for (const phase of phases) this.lifecycleTimers.push(globalThis.setTimeout(() => {
        if (this.readyState !== VisualWebSocket.OPEN) return;
        const event: AgentStateEvent = { version: 1, type: "delta", mode: "demo", operation: "upsert", agent: { ...hero, state: phase.state, progress: phase.progress, stateEnteredAt: new Date().toISOString() } };
        this.onmessage?.({ data: JSON.stringify(event) });
      }, phase.delay));
    }
  }
  target.WebSocket = VisualWebSocket as unknown as typeof WebSocket;
}

export function initializeVisualMode(mode: string, target: WebSocketTarget, search: string) {
  if (!isVisualMode(mode)) return null;
  const config = parseVisualConfig(search);
  installVisualWebSocket(target, config);
  return config;
}
