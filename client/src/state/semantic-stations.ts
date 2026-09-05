import type { AgentMachine } from "./store";

export const humanStateWords = {
  idle: "Idle — prepping",
  working: "Working — on the fire",
  blocked: "Blocked — at the pass",
  done: "Done — plated",
  ended: "Ended — 86'd",
} as const;
export type SemanticAgent = Pick<
  AgentMachine,
  "id" | "name" | "targetState" | "stateKnown"
>;
export function semanticStationLabel(agent: SemanticAgent) {
  return `${agent.name}, ${agent.stateKnown === false ? "Unknown — at prep" : humanStateWords[agent.targetState]}, open details`;
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
        agent.targetState === b[index]?.targetState,
    )
  );
}
export function semanticAgents(
  snapshot: ReadonlyMap<string, AgentMachine>,
): SemanticAgent[] {
  return [...snapshot.values()].map(
    ({ id, name, targetState, stateKnown }) => ({
      id,
      name,
      targetState,
      stateKnown,
    }),
  );
}
