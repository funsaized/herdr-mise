import type {
  AgentRecord,
  AgentStateEvent,
  AppMode as FeedMode,
  SourceDiagnostic,
  SourceStatus,
} from "../../../protocol/generated/agent-state-event";
import type { ThemeChoice } from "../theme/theme";
import { loadSettings, saveSettings } from "./settings-storage";

export type AppMode = FeedMode | "empty" | "disconnected" | "connecting";
export const HISTORY_LIMIT = 256;
export interface Settings {
  sound: boolean;
  atmosphere: boolean;
  doneTimeoutMs: number;
  escalationFastMs: number;
  escalationVignetteMs: number;
  theme: ThemeChoice;
}
export interface BoardEntry {
  id: string;
  name: string;
  accentIndex: number;
  runtimeMs: number;
  tickets: number;
  ticketsAvailable?: boolean;
  endedAt: number;
  finalState: AgentRecord["state"];
}
export interface StatePeriod {
  state: AgentRecord["state"];
  startedAt: number;
}
export interface AgentMachine extends AgentRecord {
  targetState: AgentRecord["state"];
  renderedState: AgentRecord["state"];
  transitionStartedAt: number;
  clearAt: number | null;
  answerReceivedUntil: number | null;
  revision: number;
  history: readonly StatePeriod[];
}
export interface StoreSnapshot {
  agents: ReadonlyMap<string, AgentMachine>;
  board: readonly BoardEntry[];
  mode: AppMode;
  feedMode: FeedMode;
  sourceStatus: SourceStatus;
  sourceDiagnostic: SourceDiagnostic | null;
  selectedId: string | null;
  settings: Settings;
  lastUpdateAt: number;
}
export interface CoarseSlice {
  count: number;
  blocked: number;
  done: number;
  mode: AppMode;
  sourceStatus: SourceStatus;
  sourceDiagnostic: SourceDiagnostic | null;
  selectedId: string | null;
  settings: Settings;
}
export type StoreEvent =
  | { type: "clear" | "busser"; agentId: string }
  | { type: "ended"; entry: BoardEntry }
  | {
      type: "state";
      agentId: string;
      from?: AgentRecord["state"];
      to: AgentRecord["state"];
    };
type Listener<T> = (value: T) => void;
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}
const nativeScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as number),
};
export const defaultSettings: Settings = {
  sound: false,
  atmosphere: true,
  doneTimeoutMs: 600_000,
  escalationFastMs: 60_000,
  escalationVignetteMs: 300_000,
  theme: "system",
};

export class AgentStore {
  private agents = new Map<string, AgentMachine>();
  private board: BoardEntry[] = [];
  private mode: AppMode = "connecting";
  private feedMode: FeedMode = "live";
  private sourceStatus: SourceStatus = "connected";
  private sourceDiagnostic: SourceDiagnostic | null = null;
  private selectedId: string | null = null;
  private settings: Settings;
  private lastUpdateAt = 0;
  private coarseListeners = new Set<Listener<CoarseSlice>>();
  private changeListeners = new Set<() => void>();
  private eventListeners = new Set<Listener<StoreEvent>>();
  private doneTimers = new Map<string, unknown>();
  private dismissedDone = new Map<string, string>();
  constructor(
    private scheduler: Scheduler = nativeScheduler,
    settings: Partial<Settings> = {},
    private settingsStorage: Pick<Storage, "getItem" | "setItem"> | null = null,
  ) {
    this.settings = {
      ...loadSettings(settingsStorage, defaultSettings),
      ...settings,
    };
  }
  snapshot(): StoreSnapshot {
    return {
      agents: this.agents,
      board: this.board,
      mode: this.mode,
      feedMode: this.feedMode,
      sourceStatus: this.sourceStatus,
      sourceDiagnostic: this.sourceDiagnostic,
      selectedId: this.selectedId,
      settings: this.settings,
      lastUpdateAt: this.lastUpdateAt,
    };
  }
  coarse(): CoarseSlice {
    const values = [...this.agents.values()];
    return {
      count: values.length,
      blocked: values.filter((a) => a.targetState === "blocked").length,
      done: values.filter((a) => a.targetState === "done").length,
      mode: this.mode,
      sourceStatus: this.sourceStatus,
      sourceDiagnostic: this.sourceDiagnostic,
      selectedId: this.selectedId,
      settings: this.settings,
    };
  }
  subscribe(listener: () => void) {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }
  subscribeCoarse(listener: Listener<CoarseSlice>) {
    this.coarseListeners.add(listener);
    return () => {
      this.coarseListeners.delete(listener);
    };
  }
  onEvent(listener: Listener<StoreEvent>) {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }
  select(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emitCoarse();
    this.emitChange();
  }
  setSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settingsStorage, this.settings);
    this.emitCoarse();
    this.emitChange();
  }
  setDisconnected() {
    if (this.mode !== "disconnected") {
      this.mode = "disconnected";
      this.emitCoarse();
      this.emitChange();
    }
  }
  lastUpdateSeconds(now = this.scheduler.now()) {
    return this.lastUpdateAt
      ? Math.max(0, Math.floor((now - this.lastUpdateAt) / 1000))
      : 0;
  }
  apply(event: AgentStateEvent) {
    if (event.type === "heartbeat") return;
    const before = this.coarse();
    this.feedMode = event.mode;
    this.lastUpdateAt = this.scheduler.now();
    if (event.type === "snapshot") {
      this.sourceStatus = event.sourceStatus;
      this.sourceDiagnostic = event.sourceDiagnostic ?? null;
      const incoming = new Set(event.agents.map((agent) => agent.id));
      for (const id of this.dismissedDone.keys())
        if (!incoming.has(id)) this.dismissedDone.delete(id);
      for (const id of this.agents.keys())
        if (!incoming.has(id)) this.remove(id);
      for (const agent of event.agents) this.upsert(agent);
    } else if (event.operation === "upsert") this.upsert(event.agent);
    else {
      this.dismissedDone.delete(event.agentId);
      this.remove(event.agentId);
    }
    this.mode =
      this.agents.size === 0 &&
      event.mode === "live" &&
      this.sourceStatus === "connected"
        ? "empty"
        : event.mode;
    this.emitChange();
    if (!sameCoarse(before, this.coarse())) this.emitCoarse();
  }
  reconcileRendered(now = this.scheduler.now(), force = false) {
    for (const machine of this.agents.values())
      if (force || now - machine.transitionStartedAt >= 520)
        machine.renderedState = machine.targetState;
  }
  destroy() {
    for (const timer of this.doneTimers.values())
      this.scheduler.clearTimeout(timer);
    this.doneTimers.clear();
    this.dismissedDone.clear();
    this.coarseListeners.clear();
    this.changeListeners.clear();
    this.eventListeners.clear();
  }
  private upsert(agent: AgentRecord) {
    if (
      agent.state === "done" &&
      this.dismissedDone.get(agent.id) === agent.stateEnteredAt
    )
      return;
    this.dismissedDone.delete(agent.id);
    const prior = this.agents.get(agent.id);
    const now = this.scheduler.now();
    if (agent.state === "ended") {
      this.end(agent, now);
      return;
    }
    const stateChanged = prior?.targetState !== agent.state;
    const enteredAt = Number.isFinite(Date.parse(agent.stateEnteredAt))
      ? Date.parse(agent.stateEnteredAt)
      : now;
    const initialHistory: readonly StatePeriod[] = [
      { state: agent.state, startedAt: enteredAt },
    ];
    const lastObservedAt = prior?.history.at(-1)?.startedAt;
    const sameStateReentered =
      !stateChanged &&
      lastObservedAt !== undefined &&
      enteredAt > lastObservedAt + 1_000;
    const history = prior
      ? stateChanged || sameStateReentered
        ? [
            ...prior.history,
            { state: agent.state, startedAt: enteredAt },
          ].slice(-HISTORY_LIMIT)
        : prior.history
      : initialHistory;
    const answerReceivedUntil =
      prior?.targetState === "blocked" && agent.state === "working"
        ? now + 2_000
        : agent.state === "working"
          ? (prior?.answerReceivedUntil ?? null)
          : null;
    const machine: AgentMachine = {
      ...agent,
      targetState: agent.state,
      renderedState: prior?.renderedState ?? agent.state,
      transitionStartedAt: stateChanged
        ? now
        : (prior?.transitionStartedAt ?? now),
      clearAt:
        agent.state === "done"
          ? (prior?.clearAt ?? now + this.settings.doneTimeoutMs)
          : null,
      answerReceivedUntil,
      revision: (prior?.revision ?? 0) + 1,
      history,
    };
    this.agents.set(agent.id, machine);
    if (stateChanged)
      this.emitEvent({
        type: "state",
        agentId: agent.id,
        from: prior?.targetState,
        to: agent.state,
      });
    if (stateChanged) {
      this.cancelDone(agent.id);
      if (agent.state === "done")
        this.doneTimers.set(
          agent.id,
          this.scheduler.setTimeout(() => {
            this.dismissedDone.set(agent.id, agent.stateEnteredAt);
            this.emitEvent({ type: "busser", agentId: agent.id });
            this.remove(agent.id);
            if (this.mode !== "disconnected")
              this.mode =
                this.agents.size === 0 &&
                this.feedMode === "live" &&
                this.sourceStatus === "connected"
                  ? "empty"
                  : this.feedMode;
            this.emitChange();
            this.emitCoarse();
          }, this.settings.doneTimeoutMs),
        );
    }
  }
  private end(agent: AgentRecord, now: number) {
    const prior = this.agents.get(agent.id),
      existingIndex = lastBoardIndex(this.board, agent.id),
      existing = existingIndex >= 0 ? this.board[existingIndex] : undefined;
    this.remove(agent.id);
    const entry: BoardEntry = {
      id: prior && existing ? `${agent.id}:${now}` : (existing?.id ?? agent.id),
      name: agent.name,
      accentIndex: agent.accentIndex,
      runtimeMs: agent.session.runtimeMs,
      tickets: agent.session.tickets,
      ticketsAvailable: agent.session.ticketsAvailable,
      endedAt: prior ? now : (existing?.endedAt ?? now),
      finalState: prior?.targetState ?? existing?.finalState ?? "ended",
    };
    if (existingIndex >= 0 && !prior) this.board[existingIndex] = entry;
    else this.board.push(entry);
    if (this.board.length > 50) this.board.splice(0, this.board.length - 50);
    this.emitEvent({ type: "ended", entry });
  }
  private remove(id: string) {
    this.cancelDone(id);
    if (this.agents.delete(id)) this.emitEvent({ type: "clear", agentId: id });
    if (this.selectedId === id) this.selectedId = null;
  }
  private cancelDone(id: string) {
    const timer = this.doneTimers.get(id);
    if (timer !== undefined) this.scheduler.clearTimeout(timer);
    this.doneTimers.delete(id);
  }
  private emitCoarse() {
    const value = this.coarse();
    for (const listener of this.coarseListeners) listener(value);
  }
  private emitChange() {
    for (const listener of this.changeListeners) listener();
  }
  private emitEvent(event: StoreEvent) {
    for (const listener of this.eventListeners) listener(event);
  }
}
function lastBoardIndex(board: readonly BoardEntry[], paneId: string) {
  const prefix = `${paneId}:`;
  for (let index = board.length - 1; index >= 0; index--) {
    const id = board[index]?.id;
    if (id === paneId || id?.startsWith(prefix)) return index;
  }
  return -1;
}
function sameCoarse(a: CoarseSlice, b: CoarseSlice) {
  return (
    a.count === b.count &&
    a.blocked === b.blocked &&
    a.done === b.done &&
    a.mode === b.mode &&
    a.sourceStatus === b.sourceStatus &&
    a.sourceDiagnostic === b.sourceDiagnostic &&
    a.selectedId === b.selectedId &&
    a.settings === b.settings
  );
}
