import type { AgentStore, StoreEvent } from "../state/store";
export type BellReason = "enter" | "fast" | "vignette";
export interface BellLogEntry { agentId: string; reason: BellReason; at: number }
export type Ding = () => void;
declare global { interface Window { webkitAudioContext?: typeof AudioContext } }

type AudioContextFactory = () => AudioContext | null;
const browserAudioContext: AudioContextFactory = () => { const Audio = window.AudioContext ?? window.webkitAudioContext; return Audio ? new Audio() : null; };

export class SharedBellAudio {
  private context: AudioContext | null = null;
  constructor(private createContext: AudioContextFactory = browserAudioContext) {}
  getContext() { return this.context; }
  async resume() { const context = this.context ??= this.createContext(); if (context?.state === "suspended") await context.resume(); }
  ding() {
    const context = this.context;
    if (!context || context.state !== "running") return;
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.frequency.value = 880; gain.gain.setValueAtTime(0.12, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.18);
  }
}

const sharedBellAudio = new SharedBellAudio();
export function resumeBellAudio() { return sharedBellAudio.resume(); }
export function webAudioDing(): Ding { return () => sharedBellAudio.ding(); }
export class BellController {
  readonly log: BellLogEntry[] = [];
  private blocked = new Map<string, { enteredAt: number; fast: boolean; vignette: boolean }>();
  private unsubscribe: () => void;
  constructor(private store: AgentStore, private ding: Ding = webAudioDing(), private now: () => number = Date.now) { this.unsubscribe = store.onEvent(event => this.onEvent(event)); }
  tick(now = this.now()) { const settings = this.store.snapshot().settings; for (const [agentId, state] of this.blocked) { const elapsed = now - state.enteredAt; if (!state.fast && elapsed >= settings.escalationFastMs) { state.fast = true; this.ring(agentId, "fast", now); } if (!state.vignette && elapsed >= settings.escalationVignetteMs) { state.vignette = true; this.ring(agentId, "vignette", now); } } }
  destroy() { this.unsubscribe(); this.blocked.clear(); }
  private onEvent(event: StoreEvent) { if (event.type !== "state") return; if (event.to === "blocked") { const enteredAt = this.now(); this.blocked.set(event.agentId, { enteredAt, fast: false, vignette: false }); this.ring(event.agentId, "enter", enteredAt); } else this.blocked.delete(event.agentId); }
  private ring(agentId: string, reason: BellReason, at: number) { if (!this.store.snapshot().settings.sound) return; this.log.push({ agentId, reason, at }); this.ding(); }
}
