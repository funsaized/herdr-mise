# Engineering backlog implementation

Branch: `engineering/backlog-hardening`, based on main
`ab800027fa9684597913ddd0704545c50992318f`.
Scope: [engineering backlog](engineering-review-backlog-2026-09-05.md), with
**ENG-011 excluded by request**. No performance-budget lane was added.

This is an implementation and evidence ledger, not a declaration that every
acceptance criterion has been satisfied. Local checks are advisory; no PR,
managed dispatch, release publication, or human gate was performed.

## Local verification

- `npm test`: 120 Node contracts plus 155 client tests passed, including the
  isolated temporary Swamp server integration test. No skipped unit tests.
- `npm run test:extensions`: 32 Deno tests passed with type checking.
- `cargo test --workspace --locked`: 118 library tests plus seven integration
  tests passed; socket permission failures are no longer treated as success.
  The same suite also passed with an empty temporary `HERDR_MISE_DIST_DIR`,
  exercising embedded fallback assets without deleting the production build.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed.
- Full cross-browser-configured visual suite: 100 passed; one hosted-only test
  explicitly skipped because `HOSTED_VISUAL_URL` was absent. Updated fallback
  click/close/focus critical path separately passed all six cases across the
  three browsers.
- Formatting, lint, type checking, token/architecture/accessibility audits,
  existing bundle-size check, environment doctor, and Swamp DAG validation
  passed. These do not substitute for manual accessibility or performance
  acceptance.
- Release-mode build and `npm run smoke` passed: embedded browser/fonts,
  12-agent demo snapshot, loopback bind, and graceful shutdown.
- Read-only discovery completed through Swamp with fetched data timestamp
  `2026-09-05T08:52:56.629Z`: no candidates outside the supported matrix among
  the integration's latest ten releases. The source is not an exhaustive
  historical release census.

Local tools: Node 26.8.1, Rust 1.97.1, Swamp
`20260904.044433.0-sha.ab26e35b`, bundled Deno 2.9.6, Vitest 4.1.11.
CI uses Node 22. Full advisory Swamp verification passed all 20 steps on committed
subject `774aa079eff38b5e762edb6dbb32b68db50361fd` in 255,633 ms (run
`8671b44f-5caa-4501-bc2e-b94a783931dd`). This evidence applies to that subject,
not subsequent changes. No managed attestation was produced; its checks require
maintainer dispatch for the current committed subject.

| Item    | Branch implementation                                                                                                                                           | Acceptance still outstanding                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENG-001 | One idempotent socket-loss transition closes and invalidates the owned socket before one retry; fake-clock regression tests.                                    | Reconnect soak with real browser/socket churn.                                                                                                     |
| ENG-002 | 256 recent history periods, ten one-second diagnostic buckets, departed normalizer eviction.                                                                    | Multi-day heap/RSS observation; bounded-collection tests are not measured memory slopes.                                                           |
| ENG-003 | Done expiry notifies subscribers, clears selection, recomputes mode, and remembers same-period dismissal.                                                       | None beyond managed execution.                                                                                                                     |
| ENG-004 | Atomic snapshot/new-cursor boundary shared by WebSocket and TUI; overflow regression test.                                                                      | None beyond managed execution.                                                                                                                     |
| ENG-005 | Required Deno extension tests, explicit execution permissions, and Clippy in managed evidence policy.                                                           | Owner-reviewed adoption on main and failing-suite managed canary.                                                                                  |
| ENG-006 | Protect script bodies/configurations, lockfiles, release contracts, and audit entrypoints; correct provenance documentation.                                    | Owner-dispatched no-op-script canary against the deployed resolver.                                                                                |
| ENG-007 | All eight readonly definitions and dynamic builder require an available OS sandbox; regression contract prevents silent opt-out.                                | **Partial:** effective readonly/write/credential/network canaries on Seatbelt and bwrap. See below.                                                |
| ENG-008 | Draft assembly, compare all existing bytes before upload, upload missing assets only, never clobber.                                                            | Signed/public retry acceptance using retained artifacts.                                                                                           |
| ENG-009 | Independent dependency installs on separate models; cheap checks first; prepared builds remove repeated client compilation; npm download-only cache.            | Representative baseline/revised p50/p95 and the proposed 30% target. No speedup is asserted.                                                       |
| ENG-010 | Automatic read-only fast PR feedback and exact-head/managed-run guidance; avoid duplicate branch-push fast jobs.                                                | Hosted time-to-first-failure observation.                                                                                                          |
| ENG-011 | Excluded. Existing checks remain unchanged in scope.                                                                                                            | Not part of this implementation.                                                                                                                   |
| ENG-012 | Full bounded decoder rejects malformed events before any mutation; fresh valid snapshot unlocks deltas; bounded invalid counter; schema/provenance fixtures.    | None beyond managed execution.                                                                                                                     |
| ENG-013 | 4 MiB cancellation-safe upstream frames, 4096-agent cap, two-second downstream sends, cancellation/weak ownership for coalescer.                                | Long-running connection/pane churn observation.                                                                                                    |
| ENG-014 | Observed state/timestamp changes bypass metric coalescing; old pending metrics cannot overwrite them; drain queued wakeups before one fetch.                    | **Partial:** supported status-subscription semantics and upstream-to-pixel measurements. One-second polling can miss brief unobserved transitions. |
| ENG-015 | Connecting state, boundary-specific disconnect copy, caught renderer rejection, visible usable DOM fallback.                                                    | None beyond managed execution.                                                                                                                     |
| ENG-016 | Chromium/Firefox/WebKit keyboard, focus, narrow-width, reduced-motion, and renderer-fallback paths; native activation double-handling fixed.                    | **Partial:** real screen-reader listening/zoom acceptance. Browser automation is not AT certification.                                             |
| ENG-017 | Required socket tests fail on missing permissions; short-lived failure traces/screenshots uploaded.                                                             | Hosted failure-artifact retrieval canary.                                                                                                          |
| ENG-018 | Named Rust toolchain aligned with CI; read-only doctor checks actual tools/direct dependency drift; documented macOS certificate workaround.                    | Clean Linux provisioning acceptance.                                                                                                               |
| ENG-019 | Existing analytics now explicitly reports retain-current-lanes and data limitations; no unsupported lane reduction.                                             | **Partial:** representative delivered before/after cohorts and a human-approved routing pilot. See below.                                          |
| ENG-020 | Separate scheduled Swamp release-discovery DAG/report, read-only GitHub integration; immutable supported matrix untouched.                                      | None beyond hosted schedule execution.                                                                                                             |
| ENG-021 | Extract pure browser lifecycle bookkeeping and TUI scene tests; preserve scene exports and existing canonical-template/legacy-snapshot contract.                | Further room/station decomposition only when a coherent behavior change justifies it.                                                              |
| ENG-022 | ETag/304, immutable fingerprinted assets, revalidated HTML, borrowed response bytes; gzip output accurately labeled estimates.                                  | Representative cold/warm browser transfer measurement, not an added budget.                                                                        |
| ENG-023 | Reusable gate schema/validator plus exact per-release identity manifests and preparation command; retain build-tool identity separately from public assets.     | Future release and manual gates remain intentional operator actions.                                                                               |
| ENG-024 | Optional state-known/ticket-availability fields distinguish unknown from idle and genuine zero from unavailable across browser/TUI details and compact display. | None beyond managed execution; strict external v1 schema consumers need the updated schema.                                                        |

## Isolation boundary that remains open

The installed `@funsaized/cli-agent` version exposes backend selection and
fail-closed availability checks. `sandboxNetwork: deny` is documented as
Seatbelt-only and denies the provider connection too. Reviewers still require
provider authentication/egress, and a readonly tool profile is not proof of an
OS read-only mount. Therefore `auto` plus `required` must not be advertised as
complete hostile-input containment.

The selected target is [disposable Linux VMs with mandatory inner bwrap
isolation](agent-worker-isolation.md), read-only reviewer source, disposable
builder checkouts, and externally enforced provider-only egress. Existing macOS
execution remains advisory, not a second production isolation target. The
installed integration's `checkFactoryViability` probe is reusable for actors,
but does not prove reviewer mounts or Linux network restrictions. Deployment,
provider authentication, and the documented positive/negative canaries remain
outstanding; no credentials, workers, or passing acceptance evidence were created.

## Review-cost decision

Read via `swamp report get @funsaized/nightshift-factory-analytics --model
the-nightshift --json`: report version 361, created
`2026-09-03T20:46:08.245Z`. Its scope contains one item, nine plan rounds, no code
rounds, 73 invocations, and **zero delivered items**. Provider-reported tokens
total 14,257,690; cost coverage includes 61 reported-zero and 12 nonzero records.
Reported zero does not mean free; driver usage is unavailable. The report has
no marginal mergeability elbow and no cost-per-delivered-item estimate.

Decision: retain the existing seven specialist lanes. Do not infer lane value,
escaped-defect rates, or before/after savings from this scope. A prospective
pilot must retain trust/security controls, persist deterministic routing and
stale-finding decisions, and compare delivered cohorts including regressions.
No paid factory work or shipping decisions were initiated to manufacture data.

## Human accessibility record to complete

Record tester/date, OS, browser/version, AT/version, zoom, motion preference,
and exact commit. Discover stations without canvas pointer input; identify
blocked work from spoken labels; open/close details and settings; verify focus
return; repeat with renderer failure and narrow/zoomed layouts. Capture actual
observations and mark unexecuted rows NOT RUN. No listening pass is claimed here.
