import {
  humanStateWords,
  semanticStationLabel,
  type SemanticAgent,
} from "../state/semantic-stations";

export function SemanticStationControls({
  agents,
  onSelect,
  label = "Agent stations",
}: {
  agents: readonly SemanticAgent[];
  onSelect(id: string, element: HTMLButtonElement): void;
  label?: string;
}) {
  return (
    <nav className="stationA11yMirror" aria-label={label}>
      {agents.map((agent) => (
        <button
          key={agent.id}
          tabIndex={-1}
          aria-label={semanticStationLabel(agent)}
          onClick={(event) => onSelect(agent.id, event.currentTarget)}
        >
          {agent.name}
          <span>
            {agent.stateKnown === false
              ? "Unknown — at prep"
              : humanStateWords[agent.targetState]}
          </span>
        </button>
      ))}
    </nav>
  );
}
