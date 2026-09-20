# Factory refactoring implementation ledger

The maintainer approved implementing the September 20 audit, including commits,
pushes and necessary protection changes. This ledger records implementation and
acceptance separately; the full seven-step program is not complete.

The working branch is `refactor/nightshift-factory-efficiency`. Delivery uses
`refactor/nightshift-factory-foundations`, excluding the separate user-authored
`68404eeb` lockfile commit. The original branch retains that commit.

| Slice               | Implementation                                                                                                                                           | Acceptance / remaining work                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline            | Journal residence, dispatch counts, observed execution intervals, candidate and managed pointers; reusable fleet report                                  | Live report and retrieval succeeded: 34 items, 872 closed visits, 642 visits with agent timing. [Sanitized baseline](software-factory-baseline-2026-09-20.json). Historical audit workflow counts have a different cohort. |
| Test receipts       | npm runner receipts bind command, source before/after, HEAD, toolchain, counts and logs; stored-receipt verification rejects stale source and zero tests | Actual npm/Git subprocess tests pass. Rust receipts and automatic approved-plan selection remain to implement. Existing transcript/reviewer proof remains supported during migration.                                      |
| Review convergence  | Shared typed contract, stable finding IDs, impact-based severity, empty passes, explicit applicability and prior findings; critical defects block        | Executable schema and severity cases pass. Historical calibration, automated disputed-finding adjudication and comparable-cohort convergence measurement remain. All seven lanes still run.                                |
| Managed shipping    | Trusted gate publishes a validated receipt; shipping consumes exact current head/base/control/policy evidence and rechecks PR/status movement            | Negative identity/dispatcher/freshness tests pass. Publisher must first land on main; old runs without receipts are rejected. Live handoff awaits managed delivery.                                                        |
| Test tiers          | Fast Node tests separated from real Swamp integration; umbrella preserves required coverage                                                              | 124 fast Node tests and 65 extension tests pass; Linux worker canary is skipped on macOS. Visual-suite decomposition and measured cold/warm critical paths remain.                                                         |
| Runtime integration | Actual temporary-server test now loads local review/ownership/correlation extensions and exercises deterministic workflow outputs                        | Local latest Swamp rejects the existing template-cloning operation before this new coverage runs. Validate with the repository-pinned managed runtime; do not remove expression provenance checks.                         |
| Selective review    | Not enabled                                                                                                                                              | Needs subject/base/policy/skill fingerprints, conservative routing, historical calibration and full-review shadow data. No reuse or throughput claim.                                                                      |
| Runtime guarantees  | Upstream and deployment dependencies unresolved                                                                                                          | Status/advance parity, atomic intake/crash recovery and provisioned Linux worker acceptance remain. Existing upstream handoff is not an installed fix.                                                                     |
| Parallel execution  | Existing limits retained                                                                                                                                 | Depends on demonstrated worker/resource isolation and measured contention.                                                                                                                                                 |

## Verification and migration

Focused verification: 65 Deno extension tests pass; one pre-existing Linux-only
worker canary is ignored on this Mac. The fast Node tier passes 124 tests; the
managed/review/workflow subset passes 33 tests. Formatting and lint pass. Workflow
validation passes for review, ship and analytics. Managed CI is still required
for the final proposed revision.

The local CLI identifies as `20260918.211634.0-sha.bcaa9695`; managed CI pins
`20260904.044433.0`. Local `test:factory` fails on existing dynamic template
creation with “arrived as data content” for deferred `self.name`/`self.workItem`
expressions. Its generated workflow report was inspected. The current upstream
factory extension is still `2026.06.24.1`; no unreviewed runtime patch was installed.

Timing semantics: elapsed stage residence includes waiting and execution.
Overlapping invocation durations are counted once within each visit. The remainder
is unattributed, not human or queue wait. Missing clocks and invocations produce
unavailable values rather than zero.

Open input: explicit factory selection for any new lifecycle runs, and the
provisioned Linux worker environment (or deployment remaining pending). Selection
is required by the software-factory skill before starting new work items. Analytics
uses existing completed records and does not advance a lifecycle.
