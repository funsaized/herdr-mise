import { useEffect, useState } from "react";
import {
  semanticQueueWords,
  semanticStateWords,
  semanticStationLabel,
  type SemanticAgent,
} from "../state/semantic-stations";
import { formatDuration } from "./duration";

export function SemanticStationControls({
  agents,
  onSelect,
  label = "Agent stations",
}: {
  agents: readonly SemanticAgent[];
  onSelect(id: string, element: HTMLButtonElement): void;
  label?: string;
}) {
  const blocked = agents.some((agent) => agent.targetState === "blocked"),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!blocked) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [blocked]);
  return (
    <nav className="stationA11yMirror" aria-label={label}>
      {agents.map((agent) => (
        <button
          key={agent.id}
          tabIndex={-1}
          aria-label={semanticStationLabel(
            agent,
            agent.targetState === "blocked" && agent.stateKnown !== false
              ? `${formatDuration(now - Date.parse(agent.stateEnteredAt))} blocked`
              : undefined,
          )}
          onClick={(event) => onSelect(agent.id, event.currentTarget)}
        >
          {agent.name}
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
