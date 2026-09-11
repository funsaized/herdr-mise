import { semanticStationNames } from "../state/semantic-stations";
import type {
  AgentMachine,
  AgentStore,
  Scheduler,
  StoreEvent,
} from "../state/store";

const BURST_MS = 100;

type StateEvent = Extract<StoreEvent, { type: "state" }>;

const nativeScheduler: Pick<Scheduler, "setTimeout" | "clearTimeout"> = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as number),
};

export class StateAnnouncementController {
  private pending = new Map<string, StateEvent>();
  private timer: unknown = null;
  private unsubscribe: () => void;

  constructor(
    private store: AgentStore,
    private announce: (message: string) => void,
    private scheduler = nativeScheduler,
  ) {
    this.unsubscribe = store.onEvent((event) => this.onEvent(event));
  }

  destroy() {
    this.unsubscribe();
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private onEvent(event: StoreEvent) {
    if (event.type === "reveal") {
      this.announce(
        `${event.count} plated cook${event.count === 1 ? "" : "s"} revealed`,
      );
      return;
    }
    if (event.type === "busser") {
      const snapshot = this.store.snapshot(),
        agent = snapshot.agents.get(event.agentId),
        name = semanticStationNames([...snapshot.agents.values()]).get(
          event.agentId,
        );
      if (agent)
        this.announce(`${name ?? agent.name} cleared from the kitchen`);
      return;
    }
    if (event.type !== "state" || event.from === undefined) return;
    this.pending.set(event.agentId, event);
    if (this.timer === null)
      this.timer = this.scheduler.setTimeout(() => this.flush(), BURST_MS);
  }

  private flush() {
    this.timer = null;
    const snapshot = this.store.snapshot(),
      stationNames = semanticStationNames([...snapshot.agents.values()]);
    const transitions = [...this.pending.values()].filter((event) => {
      const agent = snapshot.agents.get(event.agentId);
      return agent?.targetState === event.to;
    });
    this.pending.clear();
    if (transitions.length === 0) return;
    if (transitions.length === 1) {
      const event = transitions[0]!,
        agent = snapshot.agents.get(event.agentId)!;
      this.announce(
        `${stationNames.get(event.agentId) ?? agent.name} ${event.to}${event.to === "blocked" ? ", just now" : ""}`,
      );
      return;
    }
    const blocked = transitions.flatMap((event) => {
      const agent = snapshot.agents.get(event.agentId);
      return event.to === "blocked" && agent?.targetState === "blocked"
        ? [agent]
        : [];
    });
    if (blocked.length > 0) {
      this.announce(blockedSummary(blocked, stationNames));
      return;
    }
    this.announce(
      `${transitions.length} agent state changes. Use Agent stations to review.`,
    );
  }
}

function blockedSummary(
  agents: readonly AgentMachine[],
  stationNames: ReadonlyMap<string, string>,
) {
  const count = agents.length,
    names = agents
      .slice(0, 2)
      .map((agent) => stationNames.get(agent.id) ?? agent.name);
  const identities =
    count === 1
      ? names[0]
      : count === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.join(", ")}, and ${count - 2} more`;
  return `${count} agent${count === 1 ? "" : "s"} blocked: ${identities}. Use Agent stations to open details.`;
}
