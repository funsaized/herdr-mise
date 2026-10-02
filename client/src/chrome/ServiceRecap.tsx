import { useMemo, useRef, useState } from "react";
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
  const { options, labelCounts, selected, selectedRecap, rows } =
    useMemo(() => {
      const all = store.recapSummary(null, now);
      const options = all.workspaces.map((option) => ({
        ...option,
        displayLabel: workspaceDisplayName(option.label),
      }));
      const labelCounts = new Map<string, number>();
      for (const option of options)
        if (option.id !== null)
          labelCounts.set(
            option.displayLabel,
            (labelCounts.get(option.displayLabel) ?? 0) + 1,
          );
      const selected =
        scope !== null &&
        (scope === undefined
          ? options.some((w) => w.id === null)
          : options.some((w) => w.id === scope))
          ? scope
          : null;
      const selectedRecap =
        selected === null ? all : store.recapSummary(selected, now);
      const rows = selectedRecap.agents.sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      );
      return { options, labelCounts, selected, selectedRecap, rows };
      // Coarse notifications invalidate observations held by the mutable store.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store, coarse, scope, now]);
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
                : `${option.displayLabel}${(labelCounts.get(option.displayLabel) ?? 0) > 1 ? ` (${option.id})` : ""}`}
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
              <th scope="col">Identity</th>
              <th scope="col">Waits</th>
              <th scope="col">Service</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(currentPage * 20, (currentPage + 1) * 20).map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  {row.name} ({row.id})
                </th>
                <td>
                  <dl className="recapGroup">
                    <div>
                      <dt>Blocked time</dt>
                      <dd>{duration(row.blockedMs)}</dd>
                    </div>
                    <div>
                      <dt>Median wait</dt>
                      <dd>
                        <strong>{duration(row.medianWaitMs)}</strong>
                      </dd>
                    </div>
                    <div>
                      <dt>Worst wait</dt>
                      <dd>
                        <strong>{duration(row.worstWaitMs)}</strong>
                      </dd>
                    </div>
                    <div>
                      <dt>Blocked occurrences</dt>
                      <dd>{row.blockedOccurrences}</dd>
                    </div>
                  </dl>
                </td>
                <td>
                  <dl className="recapGroup">
                    <div>
                      <dt>Working</dt>
                      <dd>{duration(row.workingMs)}</dd>
                    </div>
                    <div>
                      <dt>Plated</dt>
                      <dd>{row.plated}</dd>
                    </div>
                    <div>
                      <dt>86’d</dt>
                      <dd>
                        {row.ended}
                        {row.partial ? " · partial" : ""}
                      </dd>
                    </div>
                  </dl>
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
