import type {
  AgentRecord,
  AgentStateEvent,
  AppMode,
} from "../../../protocol/generated/agent-state-event";

export const RECAP_LIMIT = 4096;
type State = AgentRecord["state"];
type Item = {
  id: string;
  name: string;
  workspaceId: string | null;
  label: string;
  state: State | "unknown" | "gap";
  generation: string;
  start: number | null;
  duration: number;
  wait: number | null;
  waitStart: number | null;
  accumulatedWait: number;
  scopedAccum: number;
  scopedWait: number | null;
  occurrence: boolean;
  ended: boolean;
  partial: boolean;
  moved?: boolean;
};
export type RecapRow = {
  id: string;
  name: string;
  workingMs: number;
  blockedMs: number;
  medianWaitMs: number | null;
  worstWaitMs: number | null;
  blockedOccurrences: number;
  plated: number;
  ended: number;
  partial: boolean;
};
export type RecapSummary = RecapRow & {
  startedAt: number | null;
  interrupted: boolean;
  truncated: boolean;
  agents: RecapRow[];
  workspaces: { id: string | null; label: string }[];
};
const elapsed = (a: number, b: number) => Math.max(0, b - a);
const fresh = (id: string, name: string): RecapRow => ({
  id,
  name,
  workingMs: 0,
  blockedMs: 0,
  medianWaitMs: null,
  worstWaitMs: null,
  blockedOccurrences: 0,
  plated: 0,
  ended: 0,
  partial: false,
});

export class ServiceRecap {
  revision = 0;
  private closed: Item[] = [];
  private current = new Map<string, Item>();
  private anchor: number | null = null;
  private mode: AppMode | null = null;
  private truncated = false;
  private startedAt: number | null = null;
  private catalog = new Map<string, string>();

  private push(item: Item) {
    this.revision++;
    if (this.closed.length === RECAP_LIMIT) {
      this.closed.shift();
      this.truncated = true;
    }
    this.closed.push(item);
  }
  private close(id: string, at: number, completed: boolean, moved = false) {
    const item = this.current.get(id);
    if (!item) return;
    this.current.delete(id);
    this.revision++;
    if (item.start !== null)
      this.push({
        ...item,
        duration: elapsed(item.start, at),
        wait:
          item.state === "blocked" && completed && item.waitStart !== null
            ? item.accumulatedWait + elapsed(item.waitStart, at)
            : null,
        scopedWait:
          item.state === "blocked" && (completed || moved)
            ? item.scopedAccum + elapsed(item.start, at)
            : null,
        partial: item.partial,
        moved,
      });
  }
  private label(agent: AgentRecord) {
    return (
      (agent.workspaceId === undefined
        ? undefined
        : this.catalog.get(agent.workspaceId)) ?? agent.workspace
    );
  }
  private record(agent: AgentRecord, at: number) {
    const old = this.current.get(agent.id),
      state =
        agent.state === "ended"
          ? "ended"
          : agent.stateKnown === false
            ? "unknown"
            : agent.state;
    if (state === "ended") {
      const active = old !== undefined;
      this.close(agent.id, at, true);
      if (
        !active &&
        this.closed.some(
          (item) =>
            item.ended &&
            item.id === agent.id &&
            item.generation === agent.stateEnteredAt,
        )
      )
        return;
      this.push({
        id: agent.id,
        name: agent.name,
        workspaceId: agent.workspaceId ?? null,
        label: this.label(agent),
        state,
        generation: agent.stateEnteredAt,
        start: null,
        duration: 0,
        wait: null,
        waitStart: null,
        accumulatedWait: 0,
        scopedAccum: 0,
        scopedWait: null,
        occurrence: false,
        ended: true,
        partial: false,
      });
      return;
    }
    const same =
      old?.state === state &&
      Date.parse(agent.stateEnteredAt) <= Date.parse(old.generation);
    const moved = old?.workspaceId !== (agent.workspaceId ?? null);
    if (same && !moved) {
      if (old) {
        if (
          old.start === null ||
          old.name !== agent.name ||
          old.label !== this.label(agent)
        )
          this.revision++;
        old.name = agent.name;
        old.label = this.label(agent);
        if (old.start === null) {
          old.start = at;
          old.waitStart = state === "blocked" ? at : null;
          old.partial = true;
        }
      }
      return;
    }
    this.close(agent.id, at, !same, moved);
    if (this.current.size === RECAP_LIMIT) {
      const first = this.current.keys().next().value;
      if (first) this.current.delete(first);
      this.truncated = true;
    }
    this.current.set(agent.id, {
      id: agent.id,
      name: agent.name,
      workspaceId: agent.workspaceId ?? null,
      label: this.label(agent),
      state,
      generation: agent.stateEnteredAt,
      start: at,
      duration: 0,
      wait: null,
      waitStart: state === "blocked" ? at : null,
      accumulatedWait:
        state === "blocked" && same && old
          ? old.accumulatedWait +
            (moved && old.waitStart !== null ? elapsed(old.waitStart, at) : 0)
          : 0,
      scopedAccum:
        state === "blocked" && same && !moved ? (old?.scopedAccum ?? 0) : 0,
      scopedWait: null,
      occurrence: !same,
      ended: false,
      partial: Boolean(same && old?.partial),
      moved,
    });
    this.revision++;
  }
  gap() {
    if (this.anchor === null) return;
    for (const id of [...this.current.keys()]) {
      const old = this.current.get(id)!;
      this.close(id, this.anchor, false);
      this.current.set(id, {
        ...old,
        start: null,
        waitStart: null,
        accumulatedWait:
          old.accumulatedWait +
          (old.waitStart !== null ? elapsed(old.waitStart, this.anchor) : 0),
        scopedAccum:
          old.scopedAccum +
          (old.state === "blocked" && old.start !== null
            ? elapsed(old.start, this.anchor)
            : 0),
        occurrence: false,
        partial: true,
      });
    }
    this.anchor = null;
    this.push({
      id: "",
      name: "",
      workspaceId: null,
      label: "",
      state: "gap",
      generation: "",
      start: null,
      duration: 0,
      wait: null,
      waitStart: null,
      accumulatedWait: 0,
      scopedAccum: 0,
      scopedWait: null,
      occurrence: false,
      ended: false,
      partial: true,
    });
  }
  apply(event: AgentStateEvent, now: number) {
    if (event.type === "heartbeat") return;
    if (this.mode !== null && this.mode !== event.mode) {
      const revision = this.revision + 1;
      Object.assign(this, new ServiceRecap());
      this.revision = revision;
    }
    this.mode = event.mode;
    if (event.type === "snapshot") {
      if (event.mode === "live" && event.sourceStatus !== "connected") {
        this.gap();
        return;
      }
      this.catalog = new Map(
        (event.workspaces ?? []).map((w) => [w.id, w.label]),
      );
      const ids = new Set(event.agents.map((agent) => agent.id));
      for (const id of this.current.keys())
        if (!ids.has(id)) this.close(id, now, true);
      for (const agent of event.agents) this.record(agent, now);
    } else {
      if (this.anchor === null) return;
      if (event.operation === "upsert") this.record(event.agent, now);
      else this.close(event.agentId, now, true);
    }
    this.startedAt ??= now;
    this.anchor = now;
  }
  summary(scope: string | null | undefined, now: number): RecapSummary {
    const rows = new Map<string, RecapRow>(),
      waits = new Map<string, number[]>(),
      workspaces = new Map<string | null, string>();
    const all = fresh("", "All");
    let interrupted = false;
    let scopedStart: number | null = null;
    for (const item of [
      ...this.closed,
      ...[...this.current.values()]
        .filter((item) => item.start !== null && this.anchor !== null)
        .map((item) => ({
          ...item,
          duration: elapsed(item.start!, now),
          wait:
            item.state === "blocked" && item.waitStart !== null
              ? item.accumulatedWait + elapsed(item.waitStart, now)
              : null,
          scopedWait:
            item.state === "blocked"
              ? item.scopedAccum + elapsed(item.start!, now)
              : null,
          partial: true,
        })),
    ]) {
      if (item.state === "gap") {
        interrupted = true;
        continue;
      }
      workspaces.set(
        item.workspaceId,
        (item.workspaceId === null
          ? undefined
          : this.catalog.get(item.workspaceId)) ?? item.label,
      );
      if (
        scope !== null &&
        (scope === undefined
          ? item.workspaceId !== null
          : item.workspaceId !== scope)
      )
        continue;
      if (item.start !== null)
        scopedStart = Math.min(scopedStart ?? item.start, item.start);
      const row = rows.get(item.id) ?? fresh(item.id, item.name);
      row.name = item.name;
      if (item.state === "working") row.workingMs += item.duration;
      if (item.state === "blocked") {
        row.blockedMs += item.duration;
        row.blockedOccurrences += Number(item.occurrence);
      }
      if (item.state === "done") row.plated += Number(item.occurrence);
      row.ended += Number(item.ended);
      row.partial ||= item.partial || (scope !== null && item.moved === true);
      const sample = scope === null ? item.wait : item.scopedWait;
      if (sample !== null)
        waits.set(item.id, [...(waits.get(item.id) ?? []), sample]);
      rows.set(item.id, row);
    }
    const values = [...rows.values()];
    const combine = (row: RecapRow, samples: number[]) => {
      samples.sort((a, b) => a - b);
      row.medianWaitMs = samples.length
        ? (samples[(samples.length - 1) >> 1] + samples[samples.length >> 1]) /
          2
        : null;
      row.worstWaitMs = samples.at(-1) ?? null;
    };
    for (const row of values) {
      all.workingMs += row.workingMs;
      all.blockedMs += row.blockedMs;
      all.blockedOccurrences += row.blockedOccurrences;
      all.plated += row.plated;
      all.ended += row.ended;
      all.partial ||= row.partial;
      combine(row, waits.get(row.id) ?? []);
    }
    combine(all, [...waits.values()].flat());
    return {
      ...all,
      partial: all.partial || interrupted || this.truncated,
      interrupted,
      truncated: this.truncated,
      startedAt:
        scopedStart ??
        (scope === null && !this.closed.length && !this.current.size
          ? this.startedAt
          : null),
      agents: values,
      workspaces: [...workspaces].map(([id, label]) => ({ id, label })),
    };
  }
}
