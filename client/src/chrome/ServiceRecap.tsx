import { useRef, useState } from "react";
import type { AgentStore, CoarseSlice } from "../state/store";
import { workspaceDisplayName } from "../scene/geometry";
import { formatDuration } from "./duration";
import { useClock } from "./use-clock";

export function ServiceRecap({
  store,
  coarse,
}: {
  store: AgentStore;
  coarse: CoarseSlice;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement>(null);
  return (
    <details
      className="serviceRecap"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <summary ref={trigger} aria-label="Service recap">
        Recap
      </summary>
      {open && <RecapContents store={store} coarse={coarse} />}
    </details>
  );
}

function RecapContents({
  store,
  coarse,
}: {
  store: AgentStore;
  coarse: CoarseSlice;
}) {
  const [scope, setScope] = useState<string | null | undefined>(
    coarse.selectedWorkspaceId,
  );
  const [page, setPage] = useState(0);
  const now = useClock(
    coarse.mode !== "disconnected" &&
      (coarse.mode === "demo" || coarse.sourceStatus === "connected"),
  );
  const recap = store.recapSummary(scope, now);
  const options = store.recapSummary(null, now).workspaces;
  const optionLabel = (option: (typeof options)[number]) =>
    workspaceDisplayName(
      coarse.workspaces.find((w) => w.id === option.id)?.label ?? option.label,
    );
  const selected =
    scope !== null &&
    (scope === undefined
      ? options.some((w) => w.id === null)
      : options.some((w) => w.id === scope))
      ? scope
      : null;
  const selectedRecap =
    selected === scope ? recap : store.recapSummary(null, now);
  const rows = selectedRecap.agents.sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const currentPage = Math.min(page, pages - 1);
  const duration = (ms: number | null) =>
    ms === null ? "Unavailable" : formatDuration(ms);
  return (
    <div>
      <p>
        <strong>Observed time blocked:</strong>{" "}
        {duration(selectedRecap.blockedMs)}. Blocked commonly awaits human
        attention; this does not prove human causation.
      </p>
      <label>
        Recap workspace{" "}
        <select
          value={
            selected === null
              ? "0"
              : String(
                  options.findIndex((w) => w.id === (selected ?? null)) + 1,
                )
          }
          onChange={(event) => {
            const index = Number(event.target.value);
            setScope(index === 0 ? null : (options[index - 1].id ?? undefined));
            setPage(0);
          }}
        >
          <option value="0">All</option>
          {options.map((option, index) => (
            <option key={index} value={index + 1}>
              {option.id === null
                ? "Unavailable identity"
                : `${optionLabel(option)}${options.filter((other) => other.id !== null && optionLabel(other) === optionLabel(option)).length > 1 ? ` (${option.id})` : ""}`}
            </option>
          ))}
        </select>
      </label>
      <p>
        Working: {duration(selectedRecap.workingMs)} · Median observed blocked
        wait: {duration(selectedRecap.medianWaitMs)} · Worst:{" "}
        {duration(selectedRecap.worstWaitMs)}
      </p>
      <p>
        Blocked occurrences: {selectedRecap.blockedOccurrences} · Plated:{" "}
        {selectedRecap.plated} · 86’d: {selectedRecap.ended}
      </p>
      <p>
        Observation started:{" "}
        {selectedRecap.startedAt === null
          ? "Unavailable"
          : new Date(selectedRecap.startedAt).toLocaleString()}{" "}
        ·{" "}
        {selectedRecap.partial
          ? "Partial/provisional observations"
          : "Observed durations"}
        {selectedRecap.interrupted
          ? " · Interrupted by source/transport gap"
          : ""}
        {selectedRecap.truncated ? " · Retained window truncated" : ""}
      </p>
      <div className="recapRows">
        <table>
          <caption>Retained agent observations</caption>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Working</th>
              <th scope="col">Blocked time</th>
              <th scope="col">Median wait</th>
              <th scope="col">Worst wait</th>
              <th scope="col">Blocked occurrences</th>
              <th scope="col">Plated</th>
              <th scope="col">86’d</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(currentPage * 20, (currentPage + 1) * 20).map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.name}</th>
                <td>{duration(row.workingMs)}</td>
                <td>{duration(row.blockedMs)}</td>
                <td>{duration(row.medianWaitMs)}</td>
                <td>{duration(row.worstWaitMs)}</td>
                <td>{row.blockedOccurrences}</td>
                <td>{row.plated}</td>
                <td>
                  {row.ended}
                  {row.partial ? " · partial" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav aria-label="Recap pages">
        <button
          type="button"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous
        </button>{" "}
        Page {currentPage + 1} of {pages}{" "}
        <button
          type="button"
          disabled={currentPage + 1 === pages}
          onClick={() => setPage(currentPage + 1)}
        >
          Next
        </button>
      </nav>
      <p>
        Local observations only; no upstream backfill. Open waits are
        provisional and can decrease when a delayed failure is discovered. Gaps
        conservatively exclude time since the last healthy state observation.
      </p>
    </div>
  );
}
