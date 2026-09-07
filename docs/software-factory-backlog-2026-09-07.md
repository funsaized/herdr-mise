# Software factory review and improvement backlog

Reviewed at `18ff0b73` on 2026-09-07. This follows the proposed-backlog convention
in `engineering-review-backlog-2026-09-05.md`; GitHub issues remain the authority
for accepted work. Initial review made no external mutations. On 2026-09-07 the user authorized
completion, commit, push, and PR merge; delivery evidence follows below.
S/M/L mean small localized change / multiple seams / upstream or operational work.
No P0 incident demonstrated. Order weighs observed impact, autonomy, cost and risk.

## Architecture and evidence

The pinned `@swamp/software-factory` 2026.06.24.1 owns definition validation,
versioned per-item state/artifact/evidence/approval records, cycle-scoped gates,
dispatch budgets, and journal writes. The canonical Nightshift YAML supplies the
lifecycle; runtime definitions snapshot it. Swamp workflows execute stages; the
resident driver selects work from fresh status. Local extension checks add runtime
identity and exact workflow-run correlation. Git workspace methods isolate builds.
Managed CI resolves trusted main controls and an exact subject, executes the
verification DAG, and validates persisted evidence before the final gate.

Read the installed upstream definition/run-data/gate/status/advance code, local
correlation and npm/workspace extensions, factory template and fan-out/failure
workflows, integration tests, managed verification, skills, and recent history
(`#136` isolation, `#143` hardening, `#153` verification recovery). Local census:
eight runtime records, seven done and one aborted; no active tracked runs. Latest
summaries cover 18 workflows, not all historical attempts. The recorded failed
verification `452655dc-0de0-41cc-89b3-961b4d722068` failed extension-tests with
`Deno runtime missing`; its log is `verification-root/log-run-1788733658073-e66e650a`.
This is a configuration defect, not evidence of random test flakiness.

The state machine validates references, schemas and reachability; advance repeats
core gates, dispatch and cycle checks. Human approval remains explicit. State
and journal are separate writes; crash atomicity is not established. Status does
not include local advance checks or the dispatch precondition. Operational
checkout exclusion and single-writer intake remain policies, not demonstrated
cross-process locks. No hosted CI rerun, crash injection, or performance benchmark
has been performed. The real isolated-serve contract passed after provisioning
was allowed network and localhost access. Review analytics already exists; no new reporting engine is
needed. Product Rust/browser timing behavior is outside these factory fixes.

## Prioritized disposition

| ID     | Priority | Status    | Outcome                                          |
| ------ | -------- | --------- | ------------------------------------------------ |
| SF-001 | P1       | completed | Preserve Deno discovery through HOME isolation   |
| SF-002 | P1       | completed | Reject unverifiable workflow freshness           |
| SF-003 | P1       | blocked   | Unify status and advance eligibility upstream    |
| SF-004 | P2       | completed | Isolate fixture Git configuration                |
| SF-005 | P2       | completed | Deterministic provisioning and process ownership |
| SF-006 | P2       | completed | Bound correlation history reads                  |
| SF-007 | P2       | blocked   | Atomic intake and crash recovery guarantees      |
| SF-008 | P2       | completed | Finalize npm preflight errors and cleanup        |

## SF-001 — Restore Deno discovery across isolated npm subjects

- Priority/category: **P1**, autonomous verification / environment correctness.
- Evidence/paths: recorded failure above; `extensions/models/npm_subject.ts`
  changes HOME but forwards DENO_EXEC_PATH only if explicitly set;
  `scripts/test-extensions.mjs` falls back to HOME/.swamp/deno/deno.
- Root cause: local execution loses the original runtime location at isolation;
  hosted CI happens to supply an explicit path.
- Impact: valid candidates cannot finish local shipping verification.
- Smallest fix: resolve the default runtime path before isolating HOME, retaining
  explicit runtime overrides and the restricted environment.
- Acceptance: isolated subject resolves the original default runtime, explicit
  managed/configured overrides still win, unrelated secrets remain excluded.
- Verification: `DENO_TLS_CA_STORE=mozilla npm run test:extensions`.
- Effort/confidence: S / high, observed failure plus source-confirmed cause.
- Dependencies/blockers: managed adoption requires current-head owner dispatch.
- Status: **completed**. Focused regression: before 1 pass / 1 fail; after 2 pass / 0 fail.
  Changed npm subject environment construction and added isolation/override tests.
  Full shipping verification remains unverified.

## SF-002 — Fail closed on unknown workflow freshness

- Priority/category: **P1**, evidence correctness / malformed input.
- Evidence/paths: `extensions/models/software_factory_run_correlation.ts` uses
  optional `createdAt` and `Date.parse` comparison; missing/invalid time bypasses
  freshness because NaN comparisons are false. Invalid state also returns pass.
- Root cause: malformed persisted state and time are treated as no restriction.
- Impact: correlation cannot substantiate current-cycle completion.
- Smallest fix: reject invalid state and unparseable required timestamps with
  actionable reasons; preserve valid historical string formats.
- Acceptance: missing/invalid/old timestamps rejected; equal/new timestamps and
  successful/failed exact-run branches behave correctly.
- Verification: bundled Deno test of `software_factory_run_correlation.test.ts`.
- Effort/confidence: S / high source evidence; regressions reproduced: baseline 4 pass / 2 fail; fixed 6 pass / 0 fail.
- Dependencies/blockers: trusted-control review before managed adoption.
- Status: **completed**.

## SF-003 — Make status describe actual advancement prerequisites

- Priority/category: **P1**, status contract / autonomy.
- Evidence/paths: installed upstream `models/software_factory.ts:buildStatus`
  evaluates gates/cycle limits, while advance separately requires dispatch;
  local correlation checks apply only to advance.
- Root cause: status and advance have different eligibility evaluators.
- Impact: a driver may see satisfied then fail advancement and waste dispatches.
- Smallest fix: shared upstream eligibility evaluation including dispatch and an
  extension-check result seam; preserve global escape transitions.
- Acceptance: parity tests for undispatched work, failed correlation, manual and
  human gates, ambiguity and exhausted cycles; packet explains each blocker.
- Verification: upstream factory status/advance parity suite plus local contracts.
- Effort/confidence: M / high source-confirmed; no live run mutated to reproduce.
- Dependencies/blockers: source owned by pinned upstream package; publish/install
  reviewed release rather than editing generated installed files.
- Status: **blocked**.

## SF-004 — Remove ambient Git configuration from test fixtures

- Priority/category: **P2**, test determinism.
- Evidence/paths: `extensions/tests/git_workspace.test.ts` fixture Git commands
  inherit signing/hooks configuration; production workspace Git suppresses it.
- Root cause: temporary directories isolate files but not user configuration.
- Impact: developer/CI disagreement on fixture commit or checkout.
- Smallest fix: suppress global/system Git configuration in fixture commands.
- Acceptance: suite passes with hostile global signing and hooks configuration;
  cleanup and actual worktree assertions remain intact.
- Verification: Deno workspace tests with temporary GIT_CONFIG_GLOBAL fixture.
- Effort/confidence: S / high; hostile signing configuration reproduced the failure.
- Dependencies/blockers: none. Changed both Git fixture helpers; see repeated
  hostile-configuration verification below. Injected command-line Git config and
  arbitrary GIT_* environment variables are not fully isolated by this change.
- Status: **completed**.

## SF-005 — Make factory integration dependency setup deterministic

- Priority/category: **P2**, test infrastructure / diagnostics.
- Evidence/paths: `scripts/nightshift-factory-instance.integration.test.mjs`
  installs into a new temp repo; baseline failed 1/1 in 1.517 s with unresolved
  factory type and registry network_error despite extension install exit zero.
  Async subprocess callback can throw parsing errors outside promise rejection;
  free-port reservation is released before serve binds; cleanup retains timer.
- Root cause: ambient registry/cache dependency and incomplete process ownership.
- Impact: suite failure before factory assertions, poor diagnostics on tool errors.
- Smallest fix: explicit pinned provisioning preflight; reject spawn/parse failures
  through awaited promises; await process close and cancel cleanup timers.
- Acceptance: offline provisioned run exercises contract; malformed output and
  failed spawn preserve logs and settle; no child/timer remains after cleanup.
- Verification: Node integration test plus targeted child-process fault tests;
  repeat real concurrent same-name/different-name cases at least ten times.
- Effort/confidence: M / high environment failure, medium race hypotheses.
- Dependencies/blockers: registry unavailable in sandbox; port race not reproduced.
- Status: **completed**.

## SF-006 — Bound workflow correlation history reads

- Priority/category: **P2**, efficiency / maintainability.
- Evidence/paths: correlation extension queries every historical workflow summary,
  then reads each sequentially. Actual summaries have empty workflowRunId metadata
  while payload attributes contain the ID; blindly filtering metadata breaks them.
- Root cause: broad history scan rather than payload run/name predicate.
- Impact: work grows with retained history; irrelevant corrupt records are hidden.
- Smallest fix: verified attribute predicate with historical compatibility tests;
  preserve duplicate detection and runtime-scoped output correlation.
- Acceptance: exact-run history found after newer siblings; unrelated records not
  read; malformed target produces useful diagnostic; measure query/read counts.
- Verification: Deno correlation tests plus read-only Swamp query equivalence.
- Effort/confidence: S / high scan evidence; no measured speedup claimed.
- Dependencies/blockers: confirm platform query errors for malformed attributes.
- Status: **completed**.

## SF-007 — Establish crash recovery and atomic intake guarantees

- Priority/category: **P2**, persistence / concurrency / resumability.
- Evidence/paths: upstream state then journal writes; fixture phase-zero document
  explicitly records definition overwrite before duplicate start failure;
  intake uses single-writer policy, per-model locks do not establish fleet lock.
- Root cause: multi-write operations lack demonstrated transactional boundary.
- Impact: partial evidence/definition mutation or duplicate ownership after crash
  or uncontrolled concurrent intake. No actual corruption observed here.
- Smallest fix: upstream create-if-absent and fault-injection tests before adding
  any local recovery system; recovery always re-reads state, never blindly starts.
- Acceptance: crash between writes resumes without duplicate dispatch/approval;
  concurrent intake cannot overwrite snapshots; orphan detection is actionable.
- Verification: upstream persistence fault-injection and isolated serve contracts.
- Effort/confidence: L / medium; risk hypothesis with documented overwrite behavior.
- Dependencies/blockers: upstream atomic API and crash-test harness.
- Status: **blocked**.

## SF-008 — Finalize npm preflight failures and cleanup

- Priority/category: **P2**, error propagation / resource ownership.
- Evidence/paths: `extensions/models/npm_subject.ts` creates log/temp before its
  try/finally; preflight HEAD, tool-version and cleanliness failures bypass cleanup
  and invocation evidence. Pump failures can bypass child.status consumption.
- Root cause: resource scope narrower than acquisition/preflight scope.
- Impact: failed operations leave temp directories and incomplete diagnostic data.
- Smallest fix: widen existing cleanup/evidence boundary; preserve primary error.
- Acceptance: injected failures at each acquisition/preflight/stream boundary
  finalize available logs, reap child, remove temp, and retain error cause.
- Verification: focused npm subject fault tests, then extension suite.
- Effort/confidence: M / high source evidence; crash/process behavior unverified.
- Dependencies/blockers: none; separate from SF-001 to keep changes reviewable.
- Status: **completed**.

## Verification ledger

All checks are local advisory checks of the uncommitted tree. No assertions were
weakened, tests skipped, timeouts increased, retries added, or suite serialized.

Exact focused commands (bundled Deno 2.9.6; Node v26.8.1; Swamp
20260904.230512.0-sha.7b111963):

```sh
DENO_TLS_CA_STORE=mozilla /Users/saiguy/.swamp/deno/deno test --node-modules-dir=none --no-lock --no-prompt extensions/tests/npm_subject.test.ts
DENO_TLS_CA_STORE=mozilla /Users/saiguy/.swamp/deno/deno test --node-modules-dir=none --no-lock --no-prompt extensions/tests/software_factory_run_correlation.test.ts
```

SF-001: baseline 1 passed / 1 failed (3 ms test execution); after 2 passed / 0
failed (1 ms). Failure: `isolating HOME lost the installed Deno runtime`.
SF-002: baseline 4 passed / 2 failed (7 ms); after 6 passed / 0 failed (6 ms).
Failures: missing timestamp accepted; malformed state bypassed correlation.
These are deterministic negative regressions, not flakiness frequency estimates.

SF-004 hostile environment reproduction:

```sh
cat > /tmp/factory-hostile.gitconfig <<'CONFIG'
[commit]
    gpgsign = true
[gpg]
    program = /nonexistent/factory-test-signer
CONFIG
GIT_CONFIG_GLOBAL=/tmp/factory-hostile.gitconfig DENO_TLS_CA_STORE=mozilla /Users/saiguy/.swamp/deno/deno test --node-modules-dir=none --no-lock --no-prompt --allow-read --allow-write --allow-env --allow-run=git extensions/tests/git_workspace.test.ts
```

Before: 0 passed / 1 failed, 71 ms test execution, 0.685 s command wall time.
Signature: `cannot exec '/nonexistent/factory-test-signer'`, `failed to write
commit object`. The normal baseline had passed: failure depends on configuration.
After: repeat the command with `extensions/tests/git_ancestry.test.ts` appended
10 times. All 10 invocations passed, 20 test executions, none failed or skipped.
Wall times in seconds: 1.699, 1.698, 1.687, 1.701, 1.685, 1.700, 1.704, 1.702,
1.713, 1.700. Fixture subprocesses now exclude global/system Git config; this
removes the demonstrated signing input rather than masking its failure.
Production assertions still test real dirty worktree reuse and commit ancestry.
No intermittent timing failure was reproduced; port/process races remain hypotheses.

Broader checks after focused passes:

```sh
DENO_TLS_CA_STORE=mozilla npm run test:extensions
node --test scripts/nightshift-autonomy-contract.test.mjs scripts/agent-isolation-contract.test.mjs scripts/managed-verification-evidence.test.mjs
node_modules/.bin/oxlint --deny-warnings extensions/models/npm_subject.ts extensions/models/software_factory_run_correlation.ts extensions/tests/npm_subject.test.ts extensions/tests/software_factory_run_correlation.test.ts extensions/tests/git_workspace.test.ts extensions/tests/git_ancestry.test.ts
git diff --check
```

Extension baseline: 35 passed / 0 failed (1 s); final: 39 passed / 0 failed (1 s),
with Deno type checking. Node contracts: 14 passed / 0 failed, 550.601 ms.
Focused lint and whitespace checks passed. Formatter applied to changed files.
No full Rust/client/browser suite was run: no product code changed.

Factory integration command:

```sh
DENO_TLS_CA_STORE=mozilla node --test scripts/nightshift-factory-instance.integration.test.mjs
```

Sandbox baseline: 0 passed / 1 failed, 1.517 s; validation log shows registry
`network_error` and unresolved `@swamp/software-factory`. An execution with network
and localhost access passed 1/1 with no skips: 41.859 s test body, 46.433 s
overall. The environment change enabled pinned dependency provisioning; no test
retry logic or timeout changed. This test
covers duplicate intake, cross-instance creation, snapshots, repair and malformed
definitions, but does not load the local correlation extension. Its result cannot
certify SF-002 or crash atomicity. No third attempt will be made if the second fails.

Remaining acceptance: full local shipping under isolated HOME, effective sandbox
canaries, fault injection, and current-head owner-dispatched managed verification.
Recommended next autonomous implementation is **SF-008** (npm preflight cleanup
and evidence), with focused failure injection. SF-003 is the most important
upstream follow-up; it needs shared status/advance eligibility rather than another
local driver workaround.

Modified files: `extensions/models/npm_subject.ts` (SF-001),
`extensions/tests/npm_subject.test.ts` (SF-001),
`extensions/models/software_factory_run_correlation.ts` (SF-002),
`extensions/tests/software_factory_run_correlation.test.ts` (SF-002),
`extensions/tests/git_workspace.test.ts` and `git_ancestry.test.ts` (SF-004),
and this backlog/evidence ledger. Initial working tree was clean. No commit,
push, issue publication, human approval, production transition, or dependency
version update was performed.

## Completion pass (2026-09-07)

- **SF-005:** locked extension inputs can be seeded from a provisioned checkout
  (`SWAMP_TEST_EXTENSION_REPO`); Swamp restores and describes the exact pinned
  type before assertions. Runtime data is never copied. Missing dependencies
  still require explicit provisioning/network access. Local-source registration
  was abandoned after two `No extensions found` failures. The supported locked
  restoration path passed. `serve --port 0` removes the released-port race;
  readiness comes from startup output, not repeated CLI validation processes.
  Spawn and malformed-JSON failures reject awaited promises with both streams.
  Cleanup awaits process close and clears the existing kill timer. A missed old
  `port` reference in restart failed once and was corrected after inspecting the
  log; the restarted-server contract subsequently passed.
- **SF-006:** run/name predicates match payload attributes (metadata can be empty),
  retain history and duplicate rejection, and report unreadable target summaries.
  Real CLI query returned exactly verification run `452655dc-0de0-41cc-89b3-961b4d722068`
  at summary version 73. Tests enforce one scoped summary query and no unrelated
  extension-level content reads. The catalog may still scan historical content
  while evaluating attributes; no indexed-query or wall-time speedup is claimed.
- **SF-008:** log acquisition, subject validation, source/tool preflight, execution,
  cleanup and evidence finalization share one failure path. Unknown evidence
  fields remain null. The first failure is preserved when logging also fails;
  secondary diagnostics are retained. Both streams and child status are settled,
  and stream/log errors cancel the owned child. Tests exercise nonexistent subject,
  wrong HEAD, broken log write/finalization, and successful actual npm execution;
  temporary HOME removal is asserted. Deno permissions explicitly add npm/node
  for these real subprocess tests; there is no broad `--allow-run` permission.
- **SF-003/SF-007 remain blocked on upstream delivery.** Latest published factory
  is still 2026.06.24.1. Read-only push permission check returned HTTP 403 for
  `funsaized` on `swamp-club/swamp-extensions`. Existing methods cannot be overridden
  by local extensions. A tested partial status fix is preserved in
  [the upstream handoff](upstream/README.md), with 165/165 upstream tests passing.
  It has not been installed or represented as full status parity. SF-007 requires
  platform create-if-absent behavior and crash injection across multiple records;
  changing the installed cache or silently forking the factory would not satisfy
  the requested compatibility and approval boundaries.

Additional local verification:

```sh
DENO_TLS_CA_STORE=mozilla /Users/saiguy/.swamp/deno/deno test --node-modules-dir=none --no-lock --no-prompt --allow-read --allow-write --allow-env --allow-run=git,npm,node extensions/tests/npm_subject.test.ts extensions/tests/software_factory_run_correlation.test.ts
DENO_TLS_CA_STORE=mozilla npm run test:extensions
node --test scripts/swamp-test-process.test.mjs scripts/nightshift-autonomy-contract.test.mjs scripts/agent-isolation-contract.test.mjs scripts/managed-verification-evidence.test.mjs scripts/workflow-contract.test.mjs
npm --prefix client run test
```

Focused extension tests: 12/12, 836 ms. Full extensions: 43/43, 2 s.
Node process and delivery contracts: 36/36, 515.558 ms. Client: 165/165
across nine files, 1.10 s. Changed-source lint, formatting and diff whitespace
checks passed. The upstream patch first reproduced the status defect (1 failed),
then all 165 tests passed in 732 ms; existing status happy paths were corrected to
record dispatch without changing their asserted outcomes.

Final integration repetition: **10/10 passed**, zero skips/failures. Each invocation
ran `DENO_TLS_CA_STORE=mozilla node --test scripts/nightshift-factory-instance.integration.test.mjs`
against a new temporary checkout and server, exercising same-name concurrent
creation, distinct instances, repair, report persistence and server restart.
Wall seconds: 39.581, 39.909, 39.819, 40.704, 39.682, 40.415, 39.374, 39.608, 38.749, 39.139.
The full `DENO_TLS_CA_STORE=mozilla npm test` additionally passed 122 Node tests
(39.138 s) and 165 client tests (869 ms). Full `npm run format:check`,
`npm run typecheck`, `node_modules/.bin/oxlint --deny-warnings .`, and
`git diff --check` passed. These runs precede commit; the exact-head managed
verification receipt and merge result will be recorded by the GitHub integration
and linked from the PR, avoiding an evidence-only commit that invalidates its head.

No permission to push upstream was inferred from permission to merge this
repository. The existing-fork lookup also found no `funsaized/swamp-extensions`
repository; its structured method failure report was inspected. The portable,
tested upstream patch is retained for maintainer contribution instead of changing
installed dependencies or claiming all eight items are complete.
