import {
  semanticQueueWords,
  semanticStateWords,
  semanticStationLabel,
  semanticStationName,
  type SemanticAgent,
} from "../state/semantic-stations";
import { stationCollisionIds, workspaceDisplayName } from "../scene/geometry";
import { formatDuration } from "./duration";
import { useClock } from "./use-clock";

export function SemanticStationControls({
  agents,
  onSelect,
  label = "Agent stations",
  tooltipAgentId = null,
}: {
  agents: readonly SemanticAgent[];
  onSelect(id: string, element: HTMLButtonElement): void;
  label?: string;
  tooltipAgentId?: string | null;
}) {
  const blocked = agents.some((agent) => agent.targetState === "blocked"),
    now = useClock(blocked),
    nameCounts = new Map<string, number>(),
    collisions = stationCollisionIds(agents);
  for (const agent of agents) {
    const name = agent.name.toUpperCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  return (
    <nav className="stationA11yMirror" aria-label={label}>
      {agents.map((agent) => (
        <button
          key={agent.id}
          tabIndex={-1}
          aria-describedby={
            agent.id === tooltipAgentId
              ? `station-tooltip-${encodeURIComponent(agent.id)}`
              : undefined
          }
          aria-label={semanticStationLabel(
            {
              ...agent,
              name: semanticStationName(
                agent,
                workspaceDisplayName(agent.workspace),
                (nameCounts.get(agent.name.toUpperCase()) ?? 0) > 1,
                collisions.has(agent.id),
              ),
            },
            agent.targetState === "blocked" && agent.stateKnown !== false
              ? `${formatDuration(now - Date.parse(agent.stateEnteredAt))} blocked`
              : undefined,
          )}
          onClick={(event) => onSelect(agent.id, event.currentTarget)}
        >
          {semanticStationName(
            agent,
            workspaceDisplayName(agent.workspace),
            (nameCounts.get(agent.name.toUpperCase()) ?? 0) > 1,
            collisions.has(agent.id),
          )}
          <span>
            {agent.stateKnown === false
              ? "Unknown — at prep"
              : semanticStateWords(agent)}
            {agent.targetState === "blocked" && agent.stateKnown !== false && (
              <>
                {semanticQueueWords(agent) && (
                  <> · {semanticQueueWords(agent)}</>
                )}{" "}
                · {formatDuration(now - Date.parse(agent.stateEnteredAt))}{" "}
                blocked
              </>
            )}
          </span>
        </button>
      ))}
    </nav>
  );
}
