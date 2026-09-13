import { BOARD_LIMIT, type AgentMachine, type BoardEntry } from "./store";
import { stationCollisionIds, workspaceDisplayName } from "../scene/geometry";

export const humanStateWords = {
  idle: "Idle — prepping",
  working: "Working — on the fire",
  blocked: "Blocked — waiting",
  done: "Done — plated",
  ended: "Ended — 86'd",
} as const;
export function freezerAnnouncement(visible: number, inspectable: number) {
  if (inspectable === 0) return "Freezer empty, no ended sessions";
  const spirits =
    visible === 1 ? "1 decorative spirit" : `${visible} decorative spirits`;
  const sessions =
    inspectable === 1
      ? "1 inspectable session"
      : `${inspectable} inspectable sessions`;
  const overflow =
    visible < inspectable
      ? `, ${inspectable - visible} not shown as spirits`
      : "";
  const retention =
    inspectable >= BOARD_LIMIT ? `, latest ${BOARD_LIMIT} retained` : "";
  return `Freezer, ${spirits}, ${sessions}${overflow}${retention}`;
}
function formatEndedClock(endedAt: number) {
  return new Date(endedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function freezerInspectorName(
  entry: Pick<BoardEntry, "id" | "name" | "endedAt">,
  board: readonly Pick<BoardEntry, "id" | "name" | "endedAt">[],
) {
  const sameName = board.filter((item) => item.name === entry.name);
  if (sameName.length === 1) return entry.name;
  const clock = formatEndedClock(entry.endedAt);
  if (
    sameName.filter((item) => formatEndedClock(item.endedAt) === clock)
      .length === 1
  )
    return `${entry.name} · ${clock}`;
  const ordinal = sameName.findIndex((item) => item.id === entry.id) + 1;
  return `${entry.name} · ${ordinal} of ${sameName.length}`;
}
export function freezerInspectorLabel(
  entry: Pick<BoardEntry, "id" | "name" | "endedAt">,
  board: readonly Pick<BoardEntry, "id" | "name" | "endedAt">[],
) {
  return `${freezerInspectorName(entry, board)}, retained ${board.findIndex((item) => item.id === entry.id) + 1} of ${board.length}, ${humanStateWords.ended}, open details`;
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
export function semanticStationLabel(agent: SemanticAgent) {
  const queue = semanticQueueWords(agent);
  return `${agent.name}, ${semanticStateWords(agent)}${queue ? `, ${queue}` : ""}, open details`;
}
export function semanticStationName(
  agent: SemanticAgent,
  workspaceName: string,
  duplicateName: boolean,
  colliding: boolean,
) {
  return `${agent.name}${duplicateName ? ` · ${workspaceName}` : ""}${colliding ? ` · ${agent.paneId ?? agent.id}` : ""}`;
}
export function semanticStationNames(agents: readonly SemanticAgent[]) {
  const nameCounts = new Map<string, number>(),
    collisions = stationCollisionIds(agents);
  for (const agent of agents) {
    const name = agent.name.toUpperCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const names = agents.map(
      (agent) =>
        [
          agent.id,
          boundedIdentity(
            semanticStationName(
              agent,
              workspaceDisplayName(agent.workspace),
              (nameCounts.get(agent.name.toUpperCase()) ?? 0) > 1,
              collisions.has(agent.id),
            ),
          ),
        ] as const,
    ),
    boundedCounts = new Map<string, number>();
  for (const [, name] of names)
    boundedCounts.set(name, (boundedCounts.get(name) ?? 0) + 1);
  return new Map(
    names.map(([id, name]) => {
      if ((boundedCounts.get(name) ?? 0) === 1) return [id, name];
      const peers = names
          .filter(([, candidate]) => candidate === name)
          .map(([candidateId]) => candidateId)
          .sort(),
        suffix = ` · agent ${peers.indexOf(id) + 1}`;
      return [id, `${boundedIdentity(name, 40 - suffix.length)}${suffix}`];
    }),
  );
}
function boundedIdentity(value: string, maxLength = 40) {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  const head = Math.floor((maxLength - 1) / 2);
  return `${characters.slice(0, head).join("")}…${characters.slice(-(maxLength - head - 1)).join("")}`;
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

export function orderedBlockedAgents<T extends SemanticAgent>(
  agents: readonly T[],
): T[] {
  return agents
    .filter(
      (agent) => agent.targetState === "blocked" && agent.stateKnown !== false,
    )
    .sort((a, b) => {
      const aTime = Date.parse(a.stateEnteredAt),
        bTime = Date.parse(b.stateEnteredAt),
        aValid = Number.isFinite(aTime),
        bValid = Number.isFinite(bTime);
      if (aValid !== bValid) return aValid ? -1 : 1;
      return aValid && aTime !== bTime
        ? aTime - bTime
        : a.id.localeCompare(b.id);
    });
}

export function nextBlockedAgent<T extends SemanticAgent>(
  agents: readonly T[],
  focusedId: string | null,
) {
  const blocked = orderedBlockedAgents(agents),
    index = blocked.findIndex((agent) => agent.id === focusedId);
  return blocked[index < 0 ? 0 : (index + 1) % blocked.length];
}
