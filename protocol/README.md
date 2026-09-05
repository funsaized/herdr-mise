# Feed v1 observation semantics

The binary serves its matching browser client. The optional v1 fields
`agent.stateKnown` and `session.ticketsAvailable` preserve the existing state
enum and numeric ticket field while making missing observations explicit.
Old deployed clients ignore these fields; strict third-party schema consumers
must adopt the updated v1 schema before consuming them. Existing fixtures with
neither field still round-trip unchanged.

- `stateKnown: false` means Herdr reported unknown. Mise places the agent at
  prep to keep it visible, labels it **Unknown**, and does not assert it is idle.
- `ticketsAvailable: false` means unavailable, regardless of the placeholder
  numeric value. `true` permits an observed zero. Without the flag, legacy
  nonzero counts remain available and legacy zero remains unavailable.
- Live Herdr snapshots currently do not supply ticket counts. Demo counts are
  explicitly available within the already labeled demo service.
- `runtimeMs` is time since this process first observed the pane (Mise time),
  not the upstream session lifetime. Departure or process restart resets it.
  State timestamps likewise describe observations, not unseen history.

`snapshot-provenance.v1.json` covers unknown/unavailable and observed-zero
records across the decoder, Rust schema round-trip, and detail presentation.
Browser local history retains the latest 256 transitions; diagnostics retain
one second in at most ten 100 ms buckets. Neither implies complete history.

The client additionally rejects messages over 4 MiB of string characters,
rosters over 4096 records, duplicate IDs, unsafe integers, and strings over
4096 characters. These are resource limits beyond the shared shape schema.
