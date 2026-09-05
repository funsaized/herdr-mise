import type { Rect } from "./layout";
import type { AgentMachine } from "../state/store";

export const BUSSER_SWEEP_MS = 700;
export interface BusserSweepSample {
  progress: number;
  x: number;
  y: number;
  alpha: number;
}
export function busserSweepSample(
  rect: Rect,
  startedAt: number,
  now: number,
): BusserSweepSample | null {
  const progress = Math.max(
    0,
    Math.min(1, (now - startedAt) / BUSSER_SWEEP_MS),
  );
  if (now - startedAt >= BUSSER_SWEEP_MS) return null;
  const inset = Math.min(rect.width * 0.12, 18),
    x = rect.x + inset + (rect.width - inset * 2) * progress,
    y = rect.y + rect.height * 0.43,
    alpha = progress < 0.82 ? 1 : (1 - progress) / 0.18;
  return { progress, x, y, alpha };
}
export function shouldDisposeRetainedStation(
  liveAgentIds: ReadonlySet<string>,
  id: string,
) {
  return !liveAgentIds.has(id);
}
export function shouldReconcileBusserClear(
  activeSweepIds: ReadonlySet<string>,
  id: string,
) {
  return activeSweepIds.has(id);
}
export function sceneMotionPolicy(reduced: boolean) {
  const enabled = !reduced;
  return {
    idle: enabled,
    steam: enabled,
    cook: enabled,
    escalation: enabled,
    travel: enabled,
    busser: enabled,
    transitions: enabled,
  };
}
export function sceneContinuousMotion(
  reduced: boolean,
  agents: Iterable<Pick<AgentMachine, "targetState">>,
) {
  return (
    !reduced && [...agents].some((agent) => agent.targetState === "working")
  );
}
export class BusserSweepTimeline {
  private sweeps = new Map<string, { rect: Rect; startedAt: number }>();
  start(id: string, rect: Rect, now: number) {
    this.sweeps.set(id, { rect: { ...rect }, startedAt: now });
  }
  sample(id: string, now: number) {
    const sweep = this.sweeps.get(id);
    if (!sweep) return null;
    const sample = busserSweepSample(sweep.rect, sweep.startedAt, now);
    if (!sample) this.sweeps.delete(id);
    return sample;
  }
  ids() {
    return [...this.sweeps.keys()];
  }
  has(id: string) {
    return this.sweeps.has(id);
  }
  clear() {
    this.sweeps.clear();
  }
  get size() {
    return this.sweeps.size;
  }
}
