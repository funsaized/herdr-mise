import type { AgentRecord, AgentStateEvent, AppMode as FeedMode, SourceStatus } from "../../../protocol/generated/agent-state-event";
import type { ThemeChoice } from "../theme/theme";
import { loadSettings, saveSettings, type SettingsStorage } from "./settings-storage";

export type AppMode = FeedMode | "empty" | "disconnected";
export interface Settings { sound: boolean; doneTimeoutMs: number; escalationFastMs: number; escalationVignetteMs: number; theme: ThemeChoice }
export interface BoardEntry { id: string; name: string; runtimeMs: number; tickets: number; endedAt: number; finalState: AgentRecord["state"] }
export interface StatePeriod { state: AgentRecord["state"]; startedAt: number }
export interface AgentMachine extends AgentRecord { targetState: AgentRecord["state"]; renderedState: AgentRecord["state"]; transitionStartedAt: number; clearAt: number | null; answerReceivedUntil: number | null; revision: number; history: readonly StatePeriod[] }
export interface StoreSnapshot { agents: ReadonlyMap<string, AgentMachine>; board: readonly BoardEntry[]; mode: AppMode; feedMode: FeedMode; sourceStatus: SourceStatus; selectedId: string | null; settings: Settings; lastUpdateAt: number }
export interface CoarseSlice { count: number; blocked: number; done: number; mode: AppMode; sourceStatus: SourceStatus; selectedId: string | null; settings: Settings }
export type StoreEvent = { type: "clear" | "busser"; agentId: string } | { type: "ended"; entry: BoardEntry } | { type: "state"; agentId: string; from?: AgentRecord["state"]; to: AgentRecord["state"] };
type Listener<T> = (value: T) => void;
export interface Scheduler { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void }
const nativeScheduler: Scheduler = { now: () => Date.now(), setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id as number) };
export const defaultSettings: Settings = { sound: false, doneTimeoutMs: 600_000, escalationFastMs: 60_000, escalationVignetteMs: 300_000, theme: "system" };

export class AgentStore {
  private agents = new Map<string, AgentMachine>();
  private board: BoardEntry[] = [];
  private mode: AppMode = "empty";
  private feedMode: FeedMode = "live";
  private sourceStatus: SourceStatus = "connected";
  private selectedId: string | null = null;
  private settings: Settings;
  private lastUpdateAt = 0;
  private coarseListeners = new Set<Listener<CoarseSlice>>();
  private changeListeners = new Set<() => void>();
  private eventListeners = new Set<Listener<StoreEvent>>();
  private doneTimers = new Map<string, unknown>();
  constructor(private scheduler: Scheduler = nativeScheduler, settings: Partial<Settings> = {}, private settingsStorage: SettingsStorage | null = null) { this.settings = { ...loadSettings(settingsStorage, defaultSettings), ...settings }; }
  snapshot(): StoreSnapshot { return { agents: this.agents, board: this.board, mode: this.mode, feedMode: this.feedMode, sourceStatus: this.sourceStatus, selectedId: this.selectedId, settings: this.settings, lastUpdateAt: this.lastUpdateAt }; }
  coarse(): CoarseSlice { const values = [...this.agents.values()]; return { count: values.length, blocked: values.filter(a => a.targetState === "blocked").length, done: values.filter(a => a.targetState === "done").length, mode: this.mode, sourceStatus: this.sourceStatus, selectedId: this.selectedId, settings: this.settings }; }
  subscribe(listener: () => void) { this.changeListeners.add(listener); return () => { this.changeListeners.delete(listener); }; }
  subscribeCoarse(listener: Listener<CoarseSlice>) { this.coarseListeners.add(listener); return () => { this.coarseListeners.delete(listener); }; }
  onEvent(listener: Listener<StoreEvent>) { this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener); }; }
  select(id: string | null) { if (this.selectedId === id) return; this.selectedId = id; this.emitCoarse(); this.emitChange(); }
  setSettings(patch: Partial<Settings>) { this.settings = { ...this.settings, ...patch }; saveSettings(this.settingsStorage, this.settings); this.emitCoarse(); this.emitChange(); }
  setDisconnected() { if (this.mode !== "disconnected") { this.mode = "disconnected"; this.emitCoarse(); this.emitChange(); } }
  lastUpdateSeconds(now = this.scheduler.now()) { return this.lastUpdateAt ? Math.max(0, Math.floor((now - this.lastUpdateAt) / 1000)) : 0; }
  apply(event: AgentStateEvent) {
    if (event.type === "heartbeat") return;
    const before = this.coarse(); this.feedMode = event.mode; this.lastUpdateAt = this.scheduler.now();
    if (event.type === "snapshot") {
      this.sourceStatus = event.sourceStatus;
      const incoming = new Set(event.agents.map(agent => agent.id));
      for (const id of this.agents.keys()) if (!incoming.has(id)) this.remove(id);
      for (const agent of event.agents) this.upsert(agent);
    } else if (event.operation === "upsert") this.upsert(event.agent);
    else this.remove(event.agentId);
    this.mode = this.agents.size ? event.mode : "empty";
    this.emitChange(); if (!sameCoarse(before, this.coarse())) this.emitCoarse();
  }
  reconcileRendered(now = this.scheduler.now(), force = false) {
    for (const machine of this.agents.values()) if (force || now - machine.transitionStartedAt >= 520) machine.renderedState = machine.targetState;
  }
  destroy() { for (const timer of this.doneTimers.values()) this.scheduler.clearTimeout(timer); this.doneTimers.clear(); this.coarseListeners.clear(); this.changeListeners.clear(); this.eventListeners.clear(); }
  private upsert(agent: AgentRecord) {
    const prior = this.agents.get(agent.id); const now = this.scheduler.now();
    if (agent.state === "ended") { this.end(agent, now); return; }
    const stateChanged = prior?.targetState !== agent.state;
    const enteredAt = Number.isFinite(Date.parse(agent.stateEnteredAt)) ? Date.parse(agent.stateEnteredAt) : now;
    const initialHistory: readonly StatePeriod[] = [{ state: agent.state, startedAt: enteredAt }];
    const lastObservedAt = prior?.history.at(-1)?.startedAt;
    const sameStateReentered = !stateChanged && lastObservedAt !== undefined && enteredAt > lastObservedAt + 1_000;
    const history = prior ? (stateChanged || sameStateReentered ? [...prior.history, { state: agent.state, startedAt: enteredAt }] : prior.history) : initialHistory;
    const answerReceivedUntil = prior?.targetState === "blocked" && agent.state === "working"
      ? now + 2_000
      : agent.state === "working" ? (prior?.answerReceivedUntil ?? null) : null;
    const machine: AgentMachine = { ...agent, targetState: agent.state, renderedState: prior?.renderedState ?? agent.state, transitionStartedAt: stateChanged ? now : (prior?.transitionStartedAt ?? now), clearAt: agent.state === "done" ? (prior?.clearAt ?? now + this.settings.doneTimeoutMs) : null, answerReceivedUntil, revision: (prior?.revision ?? 0) + 1, history };
    this.agents.set(agent.id, machine);
    if (stateChanged) this.emitEvent({ type: "state", agentId: agent.id, from: prior?.targetState, to: agent.state });
    if (stateChanged) { this.cancelDone(agent.id); if (agent.state === "done") this.doneTimers.set(agent.id, this.scheduler.setTimeout(() => { this.emitEvent({ type: "busser", agentId: agent.id }); this.remove(agent.id); }, this.settings.doneTimeoutMs)); }
  }
  private end(agent: AgentRecord, now: number) {
    const prior = this.agents.get(agent.id), existingIndex = this.board.findIndex(entry => entry.id === agent.id), existing = existingIndex >= 0 ? this.board[existingIndex] : undefined;
    this.remove(agent.id);
    const entry: BoardEntry = { id: agent.id, name: agent.name, runtimeMs: agent.session.runtimeMs, tickets: agent.session.tickets, endedAt: prior ? now : (existing?.endedAt ?? now), finalState: prior?.targetState ?? existing?.finalState ?? "ended" };
    if (existingIndex >= 0 && !prior) this.board[existingIndex] = entry;
    else { if (existingIndex >= 0) this.board.splice(existingIndex, 1); this.board.push(entry); }
    if (this.board.length > 50) this.board.splice(0, this.board.length - 50);
    this.emitEvent({ type: "ended", entry });
  }
  private remove(id: string) { this.cancelDone(id); if (this.agents.delete(id)) this.emitEvent({ type: "clear", agentId: id }); if (this.selectedId === id) this.selectedId = null; }
  private cancelDone(id: string) { const timer = this.doneTimers.get(id); if (timer !== undefined) this.scheduler.clearTimeout(timer); this.doneTimers.delete(id); }
  private emitCoarse() { const value = this.coarse(); for (const listener of this.coarseListeners) listener(value); }
  private emitChange() { for (const listener of this.changeListeners) listener(); }
  private emitEvent(event: StoreEvent) { for (const listener of this.eventListeners) listener(event); }
}
function sameCoarse(a: CoarseSlice, b: CoarseSlice) { return a.count === b.count && a.blocked === b.blocked && a.done === b.done && a.mode === b.mode && a.sourceStatus === b.sourceStatus && a.selectedId === b.selectedId && a.settings === b.settings; }
