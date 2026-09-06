import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { SceneHit } from "../scene/kitchen-scene";
import {
  humanStateWords,
  semanticQueueWords,
  semanticStateWords,
  type SemanticAgent,
} from "../state/semantic-stations";
import type { AgentMachine, BoardEntry, StatePeriod } from "../state/store";
import { tokens } from "../theme/tokens";
import { formatDuration } from "./duration";
import { FocusedPanel } from "./panel-support";

const stateLabels = {
  idle: "IDLE — PREPPING",
  working: "WORKING — ON THE FIRE",
  blocked: "BLOCKED — WAITING",
  done: "DONE — PLATED",
  ended: "86'D — SESSION ENDED",
} as const;

function stateColor(agent: AgentMachine) {
  if (agent.targetState === "blocked") return tokens.semantic.blocked;
  if (agent.targetState === "working") return tokens.semantic.flame;
  if (agent.targetState === "done") return tokens.semantic.done;
  return tokens.scene.muted;
}

function useClock(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function Tooltip({
  agent,
  hit,
}: {
  agent: AgentMachine;
  hit: SceneHit;
}) {
  const now = useClock(true),
    style = {
      left: hit.rect.x + hit.rect.width / 2,
      top: Math.max(8, hit.rect.y - 8),
    };
  return (
    <div className="stationTooltip" style={style} role="tooltip">
      <strong>{agent.name}</strong>
      <span>{placementStateWords(agent, hit)}</span>
      <time>
        {formatDuration(now - Date.parse(agent.stateEnteredAt))} in state
      </time>
    </div>
  );
}

function Fact({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="fact">
      <span>{label}</span>
      <b className={mono ? "mono" : undefined}>{children}</b>
    </div>
  );
}

function HistoryStrip({
  history,
  now,
}: {
  history: readonly StatePeriod[];
  now: number;
}) {
  const start = history[0]?.startedAt ?? now,
    total = Math.max(1, now - start);
  return (
    <section className="sessionHistory" aria-label="Session history">
      <h3>SESSION HISTORY</h3>
      <div className="historyStrip">
        {history.map((period, index) => {
          const end = history[index + 1]?.startedAt ?? now,
            width = Math.max(1, ((end - period.startedAt) / total) * 100);
          return (
            <i
              key={`${period.state}-${period.startedAt}`}
              data-state={period.state}
              style={{
                width: `${width}%`,
                background: historyColor(period.state),
              }}
              title={humanStateWords[period.state]}
            />
          );
        })}
      </div>
      <div className="historyTimes">
        <time>
          {new Date(start).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
        <span>now</span>
      </div>
    </section>
  );
}

function historyColor(state: StatePeriod["state"]) {
  if (state === "blocked") return tokens.semantic.blocked;
  if (state === "working") return tokens.semantic.flame;
  if (state === "done") return tokens.semantic.done;
  return tokens.scene.ticketDone;
}

const availableText = (value: string) => value.trim() || "Unavailable";
const availableTickets = (value: number, available?: boolean) =>
  (available ?? value > 0) ? value : "Unavailable";

export function DetailCard({
  agent,
  hit,
  onClose,
}: {
  agent: AgentMachine;
  hit?: SceneHit;
  onClose(): void;
}) {
  const now = useClock(true),
    color = stateColor(agent);
  return (
    <FocusedPanel label={`${agent.name} details`}>
      <PanelHeader
        name={agent.name}
        label={
          agent.stateKnown === false
            ? "UNKNOWN — AT PREP"
            : placementStateLabel(agent, hit)
        }
        color={color}
        onClose={onClose}
      />
      <div className="facts">
        <Fact label="Workspace" mono>
          {availableText(agent.workspace)}
        </Fact>
        <Fact label="Time in state">
          {formatDuration(now - Date.parse(agent.stateEnteredAt))}
        </Fact>
        <Fact label="Tickets this session">
          {availableTickets(
            agent.session.tickets,
            agent.session.ticketsAvailable,
          )}
        </Fact>
      </div>
      <HistoryStrip history={agent.history} now={now} />
    </FocusedPanel>
  );
}

export function SessionSummary({
  entry,
  onClose,
}: {
  entry: BoardEntry;
  onClose(): void;
}) {
  const ended = new Date(entry.endedAt),
    color =
      entry.finalState === "blocked"
        ? tokens.semantic.blocked
        : entry.finalState === "working"
          ? tokens.semantic.flame
          : entry.finalState === "done"
            ? tokens.semantic.done
            : tokens.scene.muted;
  return (
    <FocusedPanel label={`${entry.name} session summary`}>
      <PanelHeader
        name={entry.name}
        label="86'D — SESSION ENDED"
        color={tokens.scene.muted}
        onClose={onClose}
      />
      <div className="facts">
        <Fact label="Mise time">{formatDuration(entry.runtimeMs)}</Fact>
        <Fact label="Tickets served">
          {availableTickets(entry.tickets, entry.ticketsAvailable)}
        </Fact>
        <Fact label="Ended at">
          {ended.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </Fact>
        <Fact label="Final state">
          <span style={{ color }}>{humanStateWords[entry.finalState]}</span>
        </Fact>
      </div>
    </FocusedPanel>
  );
}

function placementStateWords(agent: AgentMachine, hit?: SceneHit) {
  const semanticAgent: SemanticAgent = {
      ...agent,
      blockedPlacement:
        agent.targetState === "blocked" ? hit?.blockedPlacement : undefined,
    },
    queue = semanticQueueWords(semanticAgent);
  return `${semanticStateWords(semanticAgent)}${queue ? ` · ${queue}` : ""}`;
}

function placementStateLabel(agent: AgentMachine, hit?: SceneHit) {
  return agent.targetState === "blocked"
    ? placementStateWords(agent, hit).toUpperCase()
    : stateLabels[agent.targetState];
}

function PanelHeader({
  name,
  label,
  color,
  onClose,
}: {
  name: string;
  label: string;
  color: string;
  onClose(): void;
}) {
  return (
    <header className="panelHeader">
      <div>
        <h2>{name}</h2>
        <div className="stateChip">
          <i style={{ background: color }} />
          <span style={{ color }}>{label}</span>
        </div>
      </div>
      <button onClick={onClose} aria-label="Close panel">
        ✕
      </button>
    </header>
  );
}
