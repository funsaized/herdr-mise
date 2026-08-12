import type { AgentState } from "../../../protocol/generated/agent-state-event";
export interface Transition {
  from: AgentState;
  to: AgentState;
  startedAt: number;
  durationMs: number;
}
export class TransitionEngine {
  private transitions = new Map<string, Transition>();
  begin(id: string, from: AgentState, to: AgentState, now: number) {
    const transition = {
      from,
      to,
      startedAt: now,
      durationMs: Math.min(
        800,
        to === "blocked" || from === "blocked" ? 640 : 520,
      ),
    };
    this.transitions.set(id, transition);
    return transition;
  }
  target(id: string, from: AgentState, to: AgentState, now: number) {
    return this.begin(id, from, to, now);
  }
  sample(id: string, now: number) {
    const item = this.transitions.get(id);
    if (!item) return null;
    const progress = Math.min(1, (now - item.startedAt) / item.durationMs);
    if (progress >= 1) this.transitions.delete(id);
    return { ...item, progress };
  }
  reconcile() {
    this.transitions.clear();
  }
  activeCount() {
    return this.transitions.size;
  }
}
