import type {
  AgentMachine,
  AgentStore,
  StoreEvent,
  StoreSnapshot,
} from "../state/store";
export type BellReason = "enter" | "fast" | "vignette";
export const BELL_LOG_LIMIT = 256;
export interface BellLogEntry {
  agentId: string;
  reason: BellReason;
  at: number;
}
export type Ding = () => void;
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

type AudioContextFactory = () => AudioContext | null;
const browserAudioContext: AudioContextFactory = () => {
  const Audio = window.AudioContext ?? window.webkitAudioContext;
  return Audio ? new Audio() : null;
};

export class SharedBellAudio {
  private context: AudioContext | null = null;
  constructor(
    private createContext: AudioContextFactory = browserAudioContext,
  ) {}
  getContext() {
    return this.context;
  }
  async resume() {
    const context = (this.context ??= this.createContext());
    if (context?.state === "suspended") await context.resume();
  }
  ding() {
    const context = this.context;
    if (!context || context.state !== "running") return;
    const oscillator = context.createOscillator(),
      gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
  }
}

const sharedBellAudio = new SharedBellAudio();
export function resumeBellAudio() {
  return sharedBellAudio.resume();
}
export function webAudioDing(): Ding {
  return () => sharedBellAudio.ding();
}
export class BellController {
  readonly log: BellLogEntry[] = [];
  private blocked = new Map<
    string,
    {
      enteredAt: number;
      feedMode: StoreSnapshot["feedMode"];
      fast: boolean;
      vignette: boolean;
    }
  >();
  private unsubscribe: () => void;
  constructor(
    private store: AgentStore,
    private ding: Ding = webAudioDing(),
    private now: () => number = Date.now,
  ) {
    this.unsubscribe = store.onEvent((event) => this.onEvent(event));
  }
  tick(now = this.now()) {
    const snapshot = this.store.snapshot(),
      settings = snapshot.settings,
      entered: string[] = [];
    for (const agentId of this.blocked.keys()) {
      const agent = snapshot.agents.get(agentId);
      if (agent?.targetState !== "blocked") this.blocked.delete(agentId);
    }
    for (const agent of snapshot.agents.values()) {
      if (agent.targetState !== "blocked") continue;
      const enteredAt = observedEnteredAt(agent),
        tracked = this.blocked.get(agent.id);
      if (
        !tracked ||
        tracked.enteredAt !== enteredAt ||
        tracked.feedMode !== snapshot.feedMode
      ) {
        this.blocked.set(agent.id, {
          enteredAt,
          feedMode: snapshot.feedMode,
          fast: false,
          vignette: false,
        });
        entered.push(agent.id);
      }
    }
    if (snapshot.mode === "connecting" || snapshot.mode === "disconnected")
      return;
    for (const agentId of entered) this.ring(agentId, "enter", now);
    for (const [agentId, state] of this.blocked) {
      const elapsed = now - state.enteredAt;
      if (!state.fast && elapsed >= settings.escalationFastMs) {
        state.fast = true;
        this.ring(agentId, "fast", now);
      }
      if (!state.vignette && elapsed >= settings.escalationVignetteMs) {
        state.vignette = true;
        this.ring(agentId, "vignette", now);
      }
    }
  }
  destroy() {
    this.unsubscribe();
    this.blocked.clear();
  }
  private onEvent(event: StoreEvent) {
    if (event.type === "clear") {
      this.blocked.delete(event.agentId);
      return;
    }
    if (event.type !== "state") return;
    if (event.to === "blocked") {
      const snapshot = this.store.snapshot(),
        agent = snapshot.agents.get(event.agentId);
      if (!agent) return;
      const enteredAt = observedEnteredAt(agent);
      this.blocked.set(event.agentId, {
        enteredAt,
        feedMode: snapshot.feedMode,
        fast: false,
        vignette: false,
      });
      this.ring(event.agentId, "enter", this.now());
    } else this.blocked.delete(event.agentId);
  }
  private ring(agentId: string, reason: BellReason, at: number) {
    if (!this.store.snapshot().settings.sound) return;
    this.log.push({ agentId, reason, at });
    if (this.log.length > BELL_LOG_LIMIT)
      this.log.splice(0, this.log.length - BELL_LOG_LIMIT);
    this.ding();
  }
}

function observedEnteredAt(agent: AgentMachine) {
  return agent.history.at(-1)?.startedAt ?? agent.transitionStartedAt;
}
