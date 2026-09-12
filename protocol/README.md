# Feed v1 observation semantics

The binary serves its matching browser client. The optional v1 fields
`agent.stateKnown`, `agent.paneId`, `agent.agentKind`, and `session.ticketsAvailable` preserve the existing state
enum and numeric ticket field while making missing observations explicit.
Strict decoders must adopt the updated v1 schema before consuming these fields.
For the additive inspection-identity rollout, refreshed browser clients connect to
`/ws?paneId=1`; legacy `/ws` connections receive the prior field set. Existing
connections therefore remain decodable until they reload and opt in.

Snapshots may also include a bounded `workspaces` catalog of stable `{id,label}`
records, including workspaces with no agents. `agent.workspaceId` links an agent
to that identity; the existing `agent.workspace` remains its display label.
Clients own session-local filtering, default to All, and must not infer identity
from labels or upstream focus. Legacy snapshots may omit both additions.

- `stateKnown: false` means Herdr reported unknown. Mise places the agent at
  prep to keep it visible, labels it **Unknown**, and does not assert it is idle.
- `ticketsAvailable: false` means unavailable, regardless of the placeholder
  numeric value. `true` permits an observed zero. Without the flag, legacy
  nonzero counts remain available and legacy zero remains unavailable.
- Live Herdr snapshots currently do not supply ticket counts. Demo counts are
  explicitly available within the already labeled demo service.
- `id` is Herdr's stable `terminal_id`; `paneId` and `workspace` are mutable
  locators. Herdr protocols 17, 19, and 20 expose terminal identity and preserve
  it when moving the attached terminal, so Mise uses no pane-ID fallback.
- `agentKind` is the trimmed, non-empty upstream `agent` value. It is never
  inferred from names, sessions, worktree metadata, or model-like fields.
- Full workspace labels and pane locators appear only in explicit inspection.
  Compact station labels use the workspace basename and append the exact current
  `paneId` only when active name/basename pairs collide.
- `runtimeMs` is time since this process first observed the terminal identity (Mise time),
  not the upstream session lifetime. Departure or process restart resets it.
  Server `stateEnteredAt` timestamps mark server observations and preserve
  same-state re-entry detection; they do not establish upstream session age.

Herdr's process-scoped `state_change_seq` remains internal to the adapter. A
strict increase between two known values for the same terminal identity proves
that continuity was interrupted, even when the observed state is unchanged, so
the adapter refreshes `stateEnteredAt` to the local snapshot receipt time. The
sequence reveals neither the intermediate states nor their transition times.
Equal values preserve the current period. An absent value preserves the period
and clears the comparison baseline; the next known value only establishes a
baseline. A regression or reset preserves the period and rebases the baseline,
allowing a later increase to mark a boundary. An observed state or knownness
change still starts a period and stores the current baseline. Departure removes
the observation, and a Mise or Herdr process restart conservatively begins
again. Upstream `revision` is unrelated and ignored. Neither value enters
`AgentRecord`, WebSocket events, browser state, or the bounded browser history.

`snapshot-provenance.v1.json` covers unknown/unavailable and observed-zero
records across the decoder, Rust schema round-trip, and detail presentation.
Browser history is timestamped by the browser when each observation arrives,
starts with the current page, and resets on reload. It retains the latest 256
entries, including explicit unknown observations and gaps beginning at the last
valid WebSocket frame before a disconnect. A reconnect snapshot starts a fresh
observation even when the state is unchanged. Diagnostics retain one second in
at most ten 100 ms buckets. Neither history nor diagnostics implies complete
upstream history.
Polling cannot observe an exit and replacement that both occur between snapshots.

The client additionally rejects messages over 4 MiB of string characters,
rosters over 4096 records, duplicate IDs, unsafe integers, and strings over
4096 UTF-16 units. The adapter rejects empty, oversized, or duplicate pane IDs
before changing normalization history and truncates display-only names and
workspace labels to that same string ceiling. IDs are never truncated, and an
aggregate normalized snapshot that would exceed the browser frame limit is
rejected atomically.

A schema-rejected state event invalidates browser synchronization: the socket
closes, reconnects, and waits at most 2.9 seconds for a fresh snapshot. Deltas
and heartbeats do not extend that initial wait. A second rejection before an
accepted snapshot is shown as an incompatible browser-to-Mise feed; Feed v1 and
Herdr compatibility are unchanged.
