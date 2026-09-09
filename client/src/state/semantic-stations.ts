import type { AgentMachine } from "./store";

export const humanStateWords = {
  idle: "Idle — prepping",
  working: "Working — on the fire",
  blocked: "Blocked — waiting",
  done: "Done — plated",
  ended: "Ended — 86'd",
} as const;
export function freezerAnnouncement(visible: number, total: number) {
  return `Freezer, ${visible} of ${total} ended chefs shown`;
}
export type SemanticAgent = Pick<
  AgentMachine,
  | "id"
  | "paneId"
  | "agentKind"
  | "name"
  | "workspace"
  | "targetState"
  | "stateKnown"
  | "stateEnteredAt"
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
export function semanticStationName(agent: SemanticAgent, colliding: boolean) {
  return `${agent.name}${colliding ? ` · ${agent.paneId ?? agent.id}` : ""}`;
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
        agent.paneId === b[index]?.paneId &&
        agent.agentKind === b[index]?.agentKind &&
        agent.name === b[index]?.name &&
        agent.workspace === b[index]?.workspace &&
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
    ({
      id,
      paneId,
      agentKind,
      name,
      workspace,
      targetState,
      stateKnown,
      stateEnteredAt,
    }) => ({
      id,
      paneId,
      agentKind,
      name,
      workspace,
      targetState,
      stateKnown,
      stateEnteredAt,
    }),
  );
}
