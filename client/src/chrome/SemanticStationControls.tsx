import {
  semanticQueueWords,
  semanticStateWords,
  semanticStationLabel,
  type SemanticAgent,
} from "../state/semantic-stations";
import { formatDuration } from "./duration";
import { useClock } from "./use-clock";
import type { PageMetadata } from "../scene/kitchen-scene";

export function SemanticStationControls({
  agents,
  onSelect,
  label = "Agent stations",
  tooltipAgentId = null,
  page,
  blockedTotal = 0,
  blockedVisible = 0,
  onPreviousPage,
  onNextPage,
  onNextBlocked,
}: {
  agents: readonly SemanticAgent[];
  onSelect(id: string, element: HTMLButtonElement): void;
  label?: string;
  tooltipAgentId?: string | null;
  page?: PageMetadata;
  blockedTotal?: number;
  blockedVisible?: number;
  onPreviousPage?(): void;
  onNextPage?(): void;
  onNextBlocked?(): void;
}) {
  const blocked = agents.some((agent) => agent.targetState === "blocked"),
    now = useClock(blocked);
  return (
    <>
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
              {agent.targetState === "blocked" &&
                agent.stateKnown !== false && (
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
      {page && page.pageCount > 1 && (
        <nav className="kitchenPager" aria-label="Kitchen pages">
          <div>
            <button
              type="button"
              disabled={page.pageIndex === 0}
              onClick={onPreviousPage}
            >
              Previous
            </button>
            <strong>
              Page {page.pageIndex + 1} of {page.pageCount}
            </strong>
            <button
              type="button"
              disabled={page.pageIndex === page.pageCount - 1}
              onClick={onNextPage}
            >
              Next
            </button>
          </div>
          <span>
            {page.visibleIds.length} of {page.totalCount} cooks shown ·{" "}
            {blockedTotal} blocked / {blockedTotal - blockedVisible} off-page
          </span>
          <button
            type="button"
            disabled={blockedTotal === 0}
            onClick={onNextBlocked}
          >
            Next blocked cook
          </button>
        </nav>
      )}
    </>
  );
}
