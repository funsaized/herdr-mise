# Factory refactoring implementation ledger

The maintainer approved implementing the September 20 audit, including commits,
pushes and necessary protection changes. This ledger records implementation and
acceptance separately; the full seven-step program is not complete.

Foundation PR [#243](https://github.com/funsaized/herdr-mise/pull/243) merged as
`a4fc7edb` after exact-head managed verification passed. The original
`refactor/nightshift-factory-efficiency` branch retains the separate user-authored
`68404eeb` lockfile commit, which was excluded from delivery. Mac isolation and test-tier PR #244 merged as `e6aeef4e` after managed execution
`35524721330` and gate `35525485522` passed at `4fa57aa3`. The real shipping
consumer accepted the published receipt before merge. Remaining acceptance is tracked
in [issue #245](https://github.com/funsaized/herdr-mise/issues/245).

| Slice               | Implementation                                                                                                                                               | Acceptance / remaining work                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline            | Journal residence, dispatch counts, observed execution intervals, candidate and managed pointers; reusable fleet report                                      | Live report and retrieval succeeded: 34 items, 872 closed visits, 642 visits with agent timing. [Sanitized baseline](software-factory-baseline-2026-09-20.json). Historical audit workflow counts have a different cohort.                                                                        |
| Test receipts       | npm and Rust receipts bind command, source before/after, HEAD, toolchain, counts and logs; shared persisted verification rejects stale source and zero tests | Actual npm/Git/Cargo subprocess tests pass. Rust exact-test receipts are implemented and verified through Swamp; approved-plan selection, serial execution, stored collection and pre-review revalidation are implemented. Existing transcript/reviewer proof remains supported during migration. |
| Review convergence  | Shared typed contract, stable finding IDs, impact-based severity, empty passes, explicit applicability and prior findings; critical defects block            | Executable schema and severity cases pass. Ten sourced historical calibration cases and automated repeated-dispute parking are implemented. Independent model replay and comparable-cohort convergence measurement remain. All seven lanes still run.                                             |
| Managed shipping    | Trusted gate publishes a validated receipt; shipping consumes exact current head/base/control/policy evidence and rechecks PR/status movement                | Negative identity/dispatcher/freshness tests pass. Publisher landed through PR #243; old runs without receipts are rejected. Live publisher-to-consumer handoff passed on PR #244 before merge.                                                                                                   |
| Test tiers          | 122 fast Node cases separated from real Swamp integration and two packaging cases; browser matrix split by purpose; umbrella preserves coverage              | 122 unit and two packaging cases pass; 68 extension tests pass with the pre-existing Linux canary skipped on Mac. Browser discovery preserves all 121 cases. Controlled cold/warm critical-path measurement remains.                                                                              |
| Runtime integration | Actual temporary-server test now loads local review/ownership/correlation extensions and exercises deterministic workflow outputs                            | Local latest Swamp rejects the existing template-cloning operation before this new coverage runs. The repository-pinned managed run passed the full integration test at `b7ebfd10`; do not remove expression provenance checks.                                                                   |
| Selective review    | Shadow only; no reuse                                                                                                                                        | Subject/base/source, policy/skill and actual provider fingerprints are recorded; drift fails the round. Conservative shadow routing records missed blockers while all lanes execute. Comparable pilot data remains required; no reuse or throughput claim.                                        |
| Runtime guarantees  | Upstream and deployment dependencies unresolved                                                                                                              | Status/advance parity, atomic intake/crash recovery and macOS worker acceptance remain. Existing upstream handoff is not an installed fix.                                                                                                                                                        |
| Parallel execution  | Existing limits retained                                                                                                                                     | Depends on demonstrated worker/resource isolation and measured contention.                                                                                                                                                                                                                        |

## Verification and migration

Focused verification: 65 Deno extension tests pass; one pre-existing Linux-only
worker canary is ignored on this Mac. The fast Node tier passes 124 tests; the
managed/review/workflow subset passes 33 tests. Formatting and lint pass. Workflow
validation passes for review, ship and analytics. Foundation managed execution [35518128404](https://github.com/funsaized/herdr-mise/actions/runs/35518128404)
and exact-head gate [35518834421](https://github.com/funsaized/herdr-mise/actions/runs/35518834421)
passed at `b7ebfd10`. New changes require a new managed run.

The local CLI identifies as `20260918.211634.0-sha.bcaa9695`; managed CI pins
`20260904.044433.0`. Local `test:factory` fails on existing dynamic template
creation with “arrived as data content” for deferred `self.name`/`self.workItem`
expressions. Its generated workflow report was inspected. The current upstream
factory extension is still `2026.06.24.1`; no unreviewed runtime patch was installed.

Timing semantics: elapsed stage residence includes waiting and execution.
Overlapping invocation durations are counted once within each visit. The remainder
is unattributed, not human or queue wait. Missing clocks and invocations produce
unavailable values rather than zero.

Resolved inputs: the maintainer selected `nightshift-template`, with one
`nightshift-run-<issue>` per item, and macOS Seatbelt for the current worker
rollout. Neither factory selection nor Linux provisioning is a pending question.
The local template-cloning compatibility problem remains separate from those
decisions. Analytics uses completed records and does not advance a lifecycle.

## September 20 follow-up validation

PR #244's first managed run (`35523907481`) exposed an existing socket-fixture
race: a second newline was written after an already complete response, racing
client closure. The CLI and adapter fixtures now send one complete frame; their
focused transport tests pass. No assertion, timeout or retry was weakened.

Browser discovery remains 121 cases after separating matrix, interaction and
production-fixture suites. A fresh-asset run passed 119 cases with one expected
hosted-only skip and exposed a fixture clock-ordering race. The test now waits
for the existing state announcement before accelerating the ten-minute dismissal;
that focused case passes. The initial prepared run used stale local production
assets and is retained as failed validation, not counted as a product regression.
The fresh managed run passed the complete combined delivery head, including the
full browser suite. PR #244 was then merged without a bypass.

## Approved selection delivery

The receipt slice adds exact Rust tests, shared persisted receipt validation,
and structured selections for new template plans. The collector binds current
plan/review/approval, build invocation, command, source bytes and actual workspace
HEAD. Existing snapshots retain transcript proof. A real Swamp child workflow
executed and verified the repository CLI test; the disposable factory integration
exercises the complete production DAG with a real Cargo fixture. No production
factory approval was manufactured for testing.

The extension suite passes 72 tests with the existing Linux-only canary ignored
on Mac; 122 fast Node tests pass. Local factory-cloning compatibility remains an
upstream blocker distinct from the receipt DAG. This slice still requires its
own exact-head managed run before merge.

PR #246's first managed run (`35527051796`) found fixture provisioning gaps:
clean subjects do not contain cached Swamp bundles, and the existing isolated
factory test must load the new selection methods referenced by the ownership
hook. The fixtures now let pinned installation restore missing inputs and load
the complete local method dependency set. The failed run is not acceptance.

The second receipt run (`35527326828`) passed the factory tier and failed two
browser cases. Retained traces showed an observation-age assertion racing its
one-second display window and a large TUI scenario exhausting its 60-second
budget during its final isolation wait. The former now fixes wall time only for
the age-reset assertions; the latter is split into control and viewport/asset
scenarios with every assertion retained. The three affected cases pass locally.
Timeouts and retries are unchanged; discovery now has one additional case (122).
The delivery model can retrieve bounded diagnostic artifacts from an already
inspected run, avoiding reliance on truncated or missing console diagnostics.

## Review convergence and shadow observation

New template instances park after the same unresolved disputed high/critical
finding appears in two distinct review cycles. Same-cycle retries do not count
twice. Ordinary rework/maximum-cycle parking are mutually exclusive with this
route, and the original blocker remains unresolved. Existing instances keep their
previous routes. No human approval is generated by the evaluator.

Review capture/verification binds the actual subject, Git base and HEAD, source
bytes, policy and skill files. Completed lane records supply actual provider,
model and variant, avoiding assumptions from configured defaults. All seven
lanes execute; documentation-only recommendations are recorded solely as shadow
data, including blockers found outside the recommended subset.

## Combined delivery and workspace compatibility

PR [#246](https://github.com/funsaized/herdr-mise/pull/246) merged as `57643980`
after managed execution [35528587828](https://github.com/funsaized/herdr-mise/actions/runs/35528587828)
and exact-head gate [35529359812](https://github.com/funsaized/herdr-mise/actions/runs/35529359812)
passed at `9aebd238`. The shipping consumer accepted that exact receipt before
merge. This delivers approved selections, Rust receipts, dispute adjudication,
review identity capture, and conservative shadow routing. Final local checks were
75 extension tests and 123 fast Node tests; the full pinned managed suite passed.

A post-merge compatibility check found that recording the complete Git workspace
result sent the new `gitHead` field to the strict four-field workspace artifact
schema. Follow-up PR [#247](https://github.com/funsaized/herdr-mise/pull/247)
projects the established fields at that boundary; selected tests continue to read
actual HEAD from the Git model. A real Swamp regression executes the production
recording step: it reproduced the unexpected-field rejection before the fix and
passes afterward, including the downstream approved Rust receipt DAG. No existing
factory snapshot migration is needed. The follow-up requires its own exact-head
managed verification before merge.

Issue #245 remains open for acceptance. The September 20 open-issue census found
no other queued feature items, so a ten-item comparable pilot cannot yet be run.
Local CLI/template compatibility, upstream status/advance and atomic recovery,
complete macOS worker acceptance, model replay, and controlled cold/warm
measurements remain unresolved. All seven review lanes and existing concurrency
limits remain in force; delivery of these controls is not a measured throughput
or defect-escape improvement.

## Project-scoped local runtime compatibility

PR #247 merged as `cb4a0bca` after managed execution `35529938868` and exact-head
gate `35530726370` passed at `53619538`; the shipping consumer accepted the receipt.

The CI-pinned Mac binary (`20260904.044433.0`) now passes all three real factory
integration tests, including the isolated serve/template-cloning contract that
fails with the newer global CLI. A project-scoped launcher verifies its pinned
size and SHA-256 before use and propagates its PATH to subprocesses. Provisioning
uses the existing GitHub integration, bounded streaming, temporary-file cleanup,
and replacement only after integrity succeeds. Negative tests cover truncated,
corrupted, oversized, failed and aborted downloads, plus missing, altered and
symlinked installed binaries. The global Swamp installation remains unchanged.

Provision and use on macOS:

```sh
swamp model method run nightshift-github install_local_swamp
npm run swamp:local -- --version
npm run with:swamp-local -- npm run test:factory
npm run with:swamp-local -- npm run orchestrator:serve
npm run with:swamp-local -- npm run intake:nightshift
```

The existing `SWAMP_SERVE_ADMIN` requirement still applies. Use one server for
all factory/intake callers; do not start a second server against the same checkout.
Stop an existing newer server before switching its runtime. Provisioning does not
stop or replace a running server. `.tools/` is ignored and must be provisioned
in each trusted control checkout. The launcher fails if the runtime is missing or
modified; it never silently falls back to the global CLI. The Mac asset hashes
were read from the exact GitHub release's published SHA-256 metadata.

This establishes a tested compatibility path, not a fix in the newer CLI. The
upstream status/advance, atomic recovery, full worker acceptance and pilot
measurement items remain open. Managed Linux verification retains its existing
pinned bootstrap and protected delivery gate.

## Shared-agent lifecycle release adoption

PR [#248](https://github.com/funsaized/herdr-mise/pull/248) delivered the
project-local Mac runtime as `23276b45`. Managed execution `35539301325` and
exact-head gate `35539991822` passed at `10cdeedd`, and the shipping consumer
accepted the receipt before merge.

The maintainer explicitly approved publishing and adopting
`@funsaized/cli-agent@2026.09.20.1`. Publication succeeded on the public stable
channel. The source is preserved at
[`4dcba178`](https://github.com/funsaized/swamp-cli-agent/commit/4dcba178f4ace2e5a5a9542b35684d67e208bb78),
based on `release/funsaized-cli-agent`, whose source exactly matched the locally
installed `2026.09.05.1`. The previously committed Nightshift lock still declared
`2026.09.03.2`; this adoption reconciles that difference and includes the existing
Mac provider-credential fix as well as the new lifecycle corrections.

The new executor terminates ordinary POSIX descendants even after the provider
parent exits, forwards caller cancellation, and stops cancelled retry delays.
An upstream regression reproduced the leak before the fix. All 220 shared-source
tests pass (one existing Linux-only skip on Mac); registry formatting, quality
and content-bound review checks pass. The release dry run retains the expected
warnings that agent/orb execution uses subprocesses.

The installed source bytes match the reviewed source. Six fresh probes against
the installed release pass through the real Nightshift Seatbelt policies, with
zero surviving fixture processes across wall timeout, early parent exit and
caller cancellation for both roles. [Sanitized installed-release evidence](software-factory-worker-lifecycle-2026-09-20.json)
records the source identity and limits. Full worker acceptance remains open for
runtime-to-context cancellation wiring, credential brokers, and the complete
repository toolchain. Detached process groups are not covered. Concurrency stays
at one planner, two builders and seven reviewers.

Local adoption validation: all three real factory integration cases pass with the
project-pinned Mac CLI, alongside 76 extension tests (one existing Linux-only
skip), 124 fast Node tests, lint and formatting. The dependency change requires
its own exact-head managed run before merge.
