import type { AgentMachine } from "./store";

export const humanStateWords = {
  idle: "Idle — prepping",
  working: "Working — on the fire",
  blocked: "Blocked — waiting",
  done: "Done — plated",
  ended: "Ended — 86'd",
} as const;
export type SemanticAgent = Pick<
  AgentMachine,
  "id" | "name" | "targetState" | "stateKnown" | "stateEnteredAt"
> & {
  blockedPlacement?: {
    kind: "pass" | "station";
    queueOrdinal: number;
    queueTotal: number;
  };
};
export function semanticStateWords(agent: SemanticAgent) {
  if (agent.stateKnown === false) return "Unknown — at prep";
  if (agent.targetState !== "blocked" || !agent.blockedPlacement)
    return humanStateWords[agent.targetState];
  return agent.blockedPlacement.kind === "pass"
    ? "Blocked — at the pass"
    : "Blocked — waiting at station";
}
export function semanticQueueWords(agent: SemanticAgent) {
  return agent.stateKnown !== false && agent.blockedPlacement
    ? `queue ${agent.blockedPlacement.queueOrdinal} of ${agent.blockedPlacement.queueTotal}`
    : "";
}
export function semanticStationLabel(agent: SemanticAgent, elapsed?: string) {
  const queue = semanticQueueWords(agent);
  return `${agent.name}, ${semanticStateWords(agent)}${queue ? `, ${queue}` : ""}${elapsed ? `, ${elapsed}` : ""}, open details`;
}
export function semanticAgentsEqual(
  a: readonly SemanticAgent[],
  b: readonly SemanticAgent[],
) {
  return (
    a.length === b.length &&
    a.every(
      (agent, index) =>
        agent.id === b[index]?.id &&
        agent.name === b[index]?.name &&
        agent.stateKnown === b[index]?.stateKnown &&
        agent.targetState === b[index]?.targetState &&
        agent.stateEnteredAt === b[index]?.stateEnteredAt,
    )
  );
}
export function semanticAgents(
  snapshot: ReadonlyMap<string, AgentMachine>,
): SemanticAgent[] {
  return [...snapshot.values()].map(
    ({ id, name, targetState, stateKnown, stateEnteredAt }) => ({
      id,
      name,
      targetState,
      stateKnown,
      stateEnteredAt,
    }),
  );
}
