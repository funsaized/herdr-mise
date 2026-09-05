# Engineering review and proposed backlog

Reviewed 2026-09-05 at commit `ab800027fa9684597913ddd0704545c50992318f`.

## Assessment

herdr-mise is a deliberately small product with a comparatively substantial delivery system. It projects local Herdr agent state into a browser kitchen and a terminal kitchen. Rust owns discovery, upstream normalization, the shared Feed, HTTP/WebSocket delivery, and the TUI. React owns browser controls and accessibility; Pixi owns the scene. Nightshift adds issue intake, planning, specialist reviews, isolated implementation, verification, and human shipping decisions through Swamp.

The strongest engineering choices are the clear product boundary, shared normalization, explicit demo/source states, real upstream fixtures, deterministic presentation tests, and careful release validation. The largest opportunities are to close several concrete long-running correctness gaps and make the delivery system's coverage and cost match its sophistication.

Prioritize correctness and evidence quality before expanding features or adding more review gates. There is enough machinery here already to support a reliable product; several existing checks need better execution coverage, stronger boundaries, or more representative measurements.

This is a proposed backlog, not an assertion that these issues are accepted or absent from GitHub. GitHub issues remain the authority for accepted work. No issues were opened, factory state advanced, workflows dispatched, or releases changed during this review.

## Scope and evidence

Inspected application source, shared protocol and fixtures, browser/TUI tests, performance checks, all GitHub workflow definitions, Swamp verification and Nightshift definitions, extension implementations and test wiring, installation, packaging, acceptance, and contributor/operator documentation. The Swamp and software-factory skills informed the model census and interpretation of automation boundaries.

Evidence labels below:

- **Reproduced:** an isolated diagnostic exercised current source and demonstrated the behavior.
- **Source-confirmed:** the implementation or execution configuration directly establishes the gap; impact still needs a regression test or representative measurement.
- **Proposal:** a design or operational improvement, not a demonstrated defect.

Validation performed:

- `swamp model search --json` succeeded using `DENO_TLS_CA_STORE=mozilla` after the sandboxed macOS platform certificate lookup failed. Existing models were present.
- Client tests: **147 passed across 8 files**.
- Selected Node tests for managed evidence, release contracts, workflow contracts, and Herdr compatibility: **54 passed, none skipped**.
- In-memory TypeScript probes reproduced socket leakage, unbounded network samples, missing done-expiry notifications, and unbounded state history. These probes used fake sockets/clocks; they did not start product services.
- The installed client test runner reported **Vitest 3.2.7**, while `client/package.json` declares **^4.1.11**. The passes above are local diagnostics, not verification of a freshly installed committed dependency graph. Dependencies were not changed.

No full managed verification, Rust suite, browser session, GPU benchmark, multi-day soak, current GitHub ruleset inspection, or public release installation was performed. Workflow findings describe checked-in configuration, not observed production success rates. No actual review-cost or CI-duration claims are made without run data.

## What the repository does well

| Area                | Strength and why it matters                                                                                                                                                                                                                                           | Evidence                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product scope       | Read-only localhost projection, no remote control or telemetry, one distributable binary. A small attack surface and clear user expectations.                                                                                                                         | [README](../README.md), [architecture](architecture.md)                                                                                              |
| Domain boundaries   | Herdr protocol knowledge is concentrated in the adapter; browser and TUI consume the same normalized Feed. Presentation is kept out of upstream decoding.                                                                                                             | [adapter](../server/src/adapter.rs), [Feed](../server/src/feed.rs)                                                                                   |
| Truthful state      | Demo, incompatible source, disconnected, and empty conditions have explicit representations. Compatibility diagnostics include observed and supported protocols. Missing metrics are often labeled unavailable.                                                       | [status panels](../client/src/chrome/status-panels.tsx), [protocol](../server/src/protocol.rs)                                                       |
| Rendering           | Retained Pixi station objects, bounded particles, reduced-motion handling, hidden-tab handling, and coarse React subscriptions show deliberate attention to all-day operation.                                                                                        | [scene](../client/src/scene/kitchen-scene.ts), [store](../client/src/state/store.ts)                                                                 |
| Terminal resilience | Compact fallback, non-color blocked indicators, deterministic goldens, terminal restoration guards, and shared shutdown handling are thoughtful terminal-specific engineering.                                                                                        | [TUI runtime](../server/src/tui/mod.rs), [TUI tests](../server/tests/tui_runtime.rs)                                                                 |
| Compatibility       | Immutable upstream references, sanitized fixtures, schema checks, and protocol fixtures shared across languages create useful boundary coverage.                                                                                                                      | [compatibility manifest](../compatibility/herdr.json), [compatibility checker](../scripts/check-herdr-compatibility.mjs)                             |
| CI trust            | Separate resolver/executor/gate, exact PR identity, main ancestry, explicit owner dispatch for sensitive changes, narrow permissions, and negative evidence tests. The migration document correctly limits the attestation claim to conventional hosted-CI assurance. | [managed workflow](../.github/workflows/swamp-managed-verification.yml), [migration](managed-verification-migration.md)                              |
| Supply chain        | Action SHA pins, dependency review, Rust advisory scanning, CodeQL, Gitleaks, pinned Swamp bootstrap digest, and pinned extension dependencies.                                                                                                                       | [CI](../.github/workflows/ci.yml), [bootstrap](../scripts/install-swamp-managed.sh), [extension lock](../extensions/models/upstream_extensions.json) |
| Release engineering | Tag/version checks, native builds for three targets, macOS signing/notarization, stable acceptance gating, license notices, archive validation, and anonymous public-download checks.                                                                                 | [release workflow](../.github/workflows/release.yml), [release runbook](releasing.md)                                                                |
| Installation        | Downloads and checksums are checked before installation; exact archive membership, versioned directories, atomic link changes, and refusal to overwrite an unrelated launcher reduce recovery risk.                                                                   | [installer](../install.sh)                                                                                                                           |
| Review automation   | Persisted artifacts, freshness gates, bounded rework cycles, explicit human decisions, isolated workspaces, and failure classification make unattended work inspectable.                                                                                              | [factory template](../models/@swamp/software-factory/nightshift-template.yaml), [ship workflow](../workflows/workflow-nightshift-ship.yaml)          |
| Cost observability  | A deterministic analytics report already models review rounds, token/cost coverage, retries, attribution, and source pointers. This is a good basis for tuning review policy.                                                                                         | [analytics report](../extensions/reports/nightshift_review_analytics.ts)                                                                             |

## Prioritized backlog

P1 means the next reliability/delivery milestone; P2 means the following improvement cycle; P3 means opportunistic work or work justified by measurement. No P0 outage or exploit was demonstrated. Estimates are engineer-days, including focused tests and review, and are planning ranges rather than commitments.

| ID      | Priority | Outcome                                           | Primary dimension         | Estimate |
| ------- | -------- | ------------------------------------------------- | ------------------------- | -------- |
| ENG-001 | P1       | Close stale WebSockets before reconnecting        | Correctness, resources    | 1–2      |
| ENG-002 | P1       | Bound all-day state and diagnostic retention      | Performance, accuracy     | 2–3      |
| ENG-003 | P1       | Make done expiry an observable state transition   | Correctness, UX           | 1–2      |
| ENG-004 | P1       | Prevent stale delta replay after resnapshot       | Accuracy                  | 2–3      |
| ENG-005 | P1       | Put extension tests in managed verification       | Validation                | 2–3      |
| ENG-006 | P1       | Make verification-control provenance explicit     | Accuracy, maintainability | 3–5      |
| ENG-007 | P1       | Enforce isolation for automated agents            | Automation boundaries     | 3–5      |
| ENG-008 | P1       | Preserve published release bytes on retries       | Releasing, reliability    | 2–4      |
| ENG-009 | P2       | Shorten verification's critical path              | Efficiency                | 3–5      |
| ENG-010 | P2       | Add automatic early PR feedback                   | Contributor UX            | 2–3      |
| ENG-011 | P2       | Execute representative performance budgets        | Performance, validation   | 3–5      |
| ENG-012 | P2       | Validate complete messages before state mutation  | Correctness, recovery     | 2–3      |
| ENG-013 | P2       | Bound upstream frames and downstream stalls       | Resource reliability      | 2–4      |
| ENG-014 | P2       | Measure and reduce source-to-screen latency       | Accuracy, UX              | 2–4      |
| ENG-015 | P2       | Add renderer-failure and connection-state UX      | UX, observability         | 2–3      |
| ENG-016 | P2       | Complete real accessibility/browser acceptance    | Accessibility, UX         | 3–5      |
| ENG-017 | P2       | Surface test execution gaps and retain failures   | Validation, debugging     | 2–3      |
| ENG-018 | P2       | Make local toolchains reproducible                | Maintainability           | 2–3      |
| ENG-019 | P2       | Tune specialist review using outcome data         | Automation efficiency     | 3–5      |
| ENG-020 | P2       | Separate compatibility regression from discovery  | Compatibility accuracy    | 1–2      |
| ENG-021 | P3       | Extract coherent scene and lifecycle modules      | Maintainability           | 3–6      |
| ENG-022 | P3       | Align asset delivery with transfer measurements   | Performance               | 1–3      |
| ENG-023 | P3       | Make acceptance contracts reusable per release    | Release efficiency        | 2–4      |
| ENG-024 | P3       | Standardize missing-data and provenance semantics | Accuracy, UX              | 2–3      |

### ENG-001 — Close stale WebSockets before reconnecting

**Reproduced.** In [ws-client.ts](../client/src/state/ws-client.ts), the initial watchdog closes the socket, but `onopen` and valid messages replace it with `armStale(lose)`. `lose` schedules reconnect without closing the prior socket. The reproduction created two connections after silence and observed `oldSocketClosed: false`.

Use one idempotent loss transition that invalidates callbacks, closes the current connection, clears watchdog state, and owns exactly one retry. Add bounded backoff with jitter if repeated failures warrant it.

**Acceptance:** open-then-silent, error-without-close, repeated errors, stop-during-retry, and delayed old-generation messages never leave more than one owned live socket. Recovery requires a fresh valid snapshot. Test with a fake scheduler; verify repeated reconnects with a browser integration case.

### ENG-002 — Bound all-day state and diagnostic retention

**Reproduced/source-confirmed.** `ws-client.ts` prunes `bytes` only when `bytesPerSecond()` is called. [App.tsx](../client/src/App.tsx) calls it only while stats are open. Ten thousand heartbeat messages retained ten thousand samples with stats closed. [store.ts](../client/src/state/store.ts) copies and appends history on every transition: ten thousand transitions retained ten thousand periods, all available for rendering in the detail panel. [adapter.rs](../server/src/adapter.rs) removes departed IDs from `first_seen` but not `entered_at`, retaining timestamps and IDs indefinitely.

Prune network samples during ingestion, bound history by a documented time/count policy, and delete departed normalizer state. Preserve a summary if older history is useful. Avoid making retention depend on whether a debug UI is open.

**Acceptance:** simulated multi-day traffic and pane churn keep collection sizes bounded; the latest state and recent history remain correct. Reusing a departed pane ID with the same state gets a new entry timestamp. Heap/RSS growth is measured after warm-up, with stats both open and closed.

### ENG-003 — Make done expiry an observable state transition

**Reproduced.** The done timer in [store.ts](../client/src/state/store.ts) emits `busser` and calls `remove`, but never emits change/coarse notifications or recalculates mode. A fake-clock run ended with zero agents, `mode: live`, and zero notifications to both subscriber groups. Scene-event listeners do not substitute for React and semantic-control notifications.

Route timer mutations through the same state reconciliation/notification boundary as feed updates. Define whether a still-done upstream record should remain locally dismissed or reappear on the next update; current removal alone does not preserve a dismissal decision.

**Acceptance:** expiry updates count, selected details, semantic controls, and empty treatment immediately. Repeated done upserts and subsequent working transitions follow an explicit tested policy without flicker.

### ENG-004 — Prevent stale delta replay after resnapshot

**Source-confirmed.** On broadcast lag, [service.rs](../server/src/service.rs) sends a current snapshot but retains the receiver with older queued deltas. Those deltas can then temporarily regress the client. [tui/mod.rs](../server/src/tui/mod.rs) already resubscribes before resnapshotting. Initial subscribe-then-snapshot also warrants a concurrency test.

Implement one ordering contract for snapshot plus stream: reset the cursor before recovery snapshots and, if necessary, add monotonic sequence information so consumers reject events already represented in a snapshot. Keep browser and TUI recovery equivalent.

**Acceptance:** an integration test forces more than the broadcast capacity, recovers a slow consumer, and proves it never renders an older state after the authoritative snapshot. Include concurrent initial subscription and end/restart events.

### ENG-005 — Put extension tests in managed verification

**Source-confirmed.** [extensions/tests](../extensions/tests) contains Deno tests for ancestry, workspace safety, PR merge/linking, issue creation, run correlation, and review analytics. `npm test` runs Node scripts and Vitest; neither [verification](../workflows/workflow-verification.yaml) nor another checked-in GitHub workflow invokes this Deno test directory. The Node factory integration test is valuable but is a different test surface.

Add a pinned Deno extension-test control through an appropriate Swamp model method and include its result in managed policy/evidence. Establish explicit permissions and dependency setup. Include Rust Clippy as a separate deliberate decision, since Rust verification currently covers format/check/test but not Clippy.

**Acceptance:** a deliberately failing extension regression blocks managed verification; reports identify which suite ran and its outcome. Exercise the proposed extension behavior as well as any trusted safety controls that must remain sourced from main.

### ENG-006 — Make verification-control provenance explicit

**Source-confirmed policy gap, not a demonstrated CI exploit.** [npm_subject.ts](../extensions/models/npm_subject.ts) allowlists npm script names but reads their command bodies from the subject's `package.json`. The policy pins invocations such as `npm run test`; it does not make the underlying test command immutable. `package.json`, client test configuration, and many audit scripts are not in the sensitive-path list. The migration document's statement that proposed validators and contract tests remain passive until merged is broader than this implementation supports.

Inventory each check's controller, configuration, tests, and executable dependencies. Decide which controls must be main-owned and which intentionally exercise the proposal. Protect changes to verification entrypoints or execute invariant checks directly from trusted control. Retain honest language: the existing attestation records conventional CI execution and is not independent proof of arbitrary subject behavior.

**Acceptance:** a canary change replacing a required npm script with a successful no-op cannot satisfy the intended check without explicit policy review. Tests identify controller and subject provenance. Documentation matches the actual boundary, including the fact that separate directories on one executor are not OS isolation.

### ENG-007 — Enforce isolation for automated agents

**Source-confirmed.** Checked-in [CLI-agent models](../models/@funsaized/cli-agent) use `sandboxMode: off`, `sandboxRequired: false`, and `sandboxNetwork: allow`. Reviewers request a readonly tool profile, which is useful configuration but not evidence of enforced filesystem/network confinement.

Define and test effective permissions for planner, reviewer, and builder roles. Reviewers should be able to read the intended checkout and write their result through the designated channel; builders should write only their workspace. Make provider credential access explicit and fail closed when required isolation is unavailable. Determine current extension support before choosing the implementation.

**Acceptance:** canary review tasks cannot change repository files, read an unrelated credential fixture, or perform an unauthorized network/write action. Normal reviewer output and builder work still succeed. Record the effective sandbox mode with each invocation.

### ENG-008 — Preserve published release bytes on retries

**Source-confirmed.** [release.yml](../.github/workflows/release.yml) rebuilds artifacts and uses `gh release upload --clobber`. Signed macOS binaries may differ between builds. Stable notes comparison can block a retry because new checksums differ; prerelease retries can overwrite already-published accepted bytes. The [installer](../install.sh) deliberately refuses an installed version whose artifact checksum changes, so this is also an upgrade/recovery concern.

Publish a draft containing the complete validated asset set, then expose it. On retry, reuse retained artifacts or compare each existing public digest and upload only missing identical assets. Never replace bytes associated with a published version. Keep code signing and public verification intact.

**Acceptance:** repeated publication preserves archive hashes; partial upload resumes safely; mismatch fails before modification. A prerelease used as acceptance evidence remains byte-identical after retry. Existing installs remain idempotent.

### ENG-009 — Shorten verification's critical path

**Source-confirmed repetition; savings unmeasured.** [verification](../workflows/workflow-verification.yaml) is a linear dependency chain. It builds the client explicitly, rebuilds production and visual clients in the [E2E setup](../e2e/playwright.config.ts), then builds production again through `npm run bundle`. Type checking also runs separately after a build that invokes `tsc -b`. The managed executor has no dependency/build cache configuration, and advisory CI installs cargo-audit from source for each run.

Measure step timings first. Run cheap checks before compilation; build each asset mode once; separate prepare/build from test execution. Add safe dependency-download caches keyed by lockfiles, platform, and toolchain. Treat caches written by subject code as untrusted. Use a real Swamp DAG for independent branches, and respect shared model locks and artifact directories; a fan-out method or distinct models may be necessary.

**Acceptance:** baseline and revised p50/p95 timings accompany the change, with a target of at least 30% lower representative wall time. The same required checks and artifact identities remain in evidence. Concurrent steps have no shared-output races or per-model lock timeouts.

### ENG-010 — Add automatic early PR feedback

**Source-confirmed.** Ordinary [CI](../.github/workflows/ci.yml) runs the Rust advisory job, while the full product verification requires maintainer dispatch. Other automatic controls provide security checks and selected release builds, but contributors do not receive automatic unit/typecheck/lint feedback from the full managed lane.

Add a cheap, permissionless automatic PR lane for formatting, typing, lint, and fast unit tests. Keep the authoritative managed status and sensitive dispatch rules. Surface a concise summary linking the current head to its managed run and explain stale status/rebase requirements. Avoid duplicate push/PR work where the event semantics permit it.

**Acceptance:** an ordinary source failure gets useful feedback without waiting for a maintainer. Sensitive execution never gains secrets or write permissions. Measured time to first actionable failure improves; cancellation does not leave misleading success for a new head.

### ENG-011 — Execute representative performance budgets

**Source-confirmed coverage gap.** The dedicated [performance suite](../perf/client.perf.spec.ts) covers startup, frame/resource behavior, latency, hidden CPU, and wire rate, but is absent from managed verification. [measure-server.sh](../scripts/measure-server.sh) checks a single `ps` sample three seconds into a demo-mode process, not sustained live/TUI behavior. The perf configuration hardcodes a Metal launch argument, so it should not simply be copied into a Linux job.

Split deterministic performance contracts from hardware-sensitive measurements. Run deterministic budgets on relevant PRs and controlled browser/CPU measurements on a documented runner class or release lane. Add live fixture traffic, reconnect storms, stats-closed memory, and TUI modes. Measure source-to-pixel latency rather than only synthetic browser injection.

**Acceptance:** a known budget regression fails the intended gate. Results identify hardware, browser, sample window, distributions, and artifacts. Warm-up and noise policy are documented. Multi-day acceptance complements, rather than substitutes for, routine bounded-state tests.

### ENG-012 — Validate complete messages before state mutation

**Source-confirmed.** [ws-client.ts](../client/src/state/ws-client.ts) casts parsed JSON to `AgentStateEvent` and checks only version/type. Malformed records can enter `store.apply`; a thrown exception may follow partial mutation. `hasSnapshot` becomes true before application succeeds. The shared [schema](../protocol/schema/agent-state-event.v1.schema.json) is a useful authority but is not a runtime decoder.

Validate the complete discriminated message before marking snapshot eligibility or touching the store. Generate or maintain a small decoder with explicit schema parity, respecting bundle limits. Include a bounded diagnostic counter so invalid messages do not disappear silently.

**Acceptance:** malformed snapshots, invalid enum values, missing session objects, invalid remove/upsert shapes, and unsupported versions leave prior state unchanged. Only a fully valid snapshot unlocks deltas. Tests prove schema/TypeScript/Rust compatibility for both valid and invalid fixtures.

### ENG-013 — Bound upstream frames and downstream stalls

**Source-confirmed.** [adapter.rs](../server/src/adapter.rs) uses `read_line` into unbounded strings for snapshots, event messages, and subscription responses. Timeouts bound waiting time, not bytes read. [service.rs](../server/src/service.rs) awaits socket sends inside select branches without an explicit send deadline. [feed.rs](../server/src/feed.rs) spawns a coalescer that does not receive the shutdown token.

Define maximum frame/roster sizes from supported usage, reject oversized input with a clear source condition, bound slow-client sends, and cancel/join owned tasks. Preserve legitimate large rosters. This is primarily local robustness work under the existing localhost threat model.

**Acceptance:** oversized or newline-free fixtures cannot cause unbounded allocation; a stalled client does not retain its task indefinitely; shutdown stops the coalescer. Long-running resource tests include connection and pane churn.

### ENG-014 — Measure and reduce source-to-screen latency

**Source-confirmed design tradeoff.** [feed.rs](../server/src/feed.rs) polls snapshots every second, queues all production upserts through a 1,250 ms coalescer, and fetches another snapshot for each queued event wake. Distinct state changes within a coalescing window can collapse to the last record. [adapter.rs](../server/src/adapter.rs) decodes status-change events, but the subscription list does not explicitly request the status-change names that decoder handles.

Verify subscription semantics against supported Herdr fixtures/source. Give blocked/ended transitions an explicit latency contract; preserve significant transitions while coalescing progress-like updates. Coalesce wakeups before expensive fetches and keep polling as reconciliation. Measure the tradeoff against wire/CPU budgets.

**Acceptance:** a fixture daemon emits brief working→blocked→working transitions and the defined behavior is observable in browser and TUI. Record upstream-event-to-pixel p95/p99 latency, snapshot requests per second, and bytes per second. Do not claim a sub-250 ms end-to-end result from browser-only injection.

### ENG-015 — Add renderer-failure and connection-state UX

**Source-confirmed.** [App.tsx](../client/src/App.tsx) calls `void scene.init()` without a rejection handler; failed WebGL initialization has no explicit product fallback. The store initially reports empty/connected before the first snapshot. The disconnect panel says “Lost connection to herdr” even when the browser has lost the Mise server itself.

Add a connecting state until an authoritative snapshot arrives, catch renderer startup failures, and keep an accessible DOM status view usable when the canvas cannot initialize. Distinguish browser→Mise transport failure from Mise→Herdr source failure, retaining the kitchen personality alongside plain explanations.

**Acceptance:** forced renderer rejection produces actionable visible UI without an unhandled rejection; slow startup does not claim a confirmed empty live roster; each failure boundary has truthful copy and a tested recovery path.

### ENG-016 — Complete real accessibility/browser acceptance

**Source-confirmed limitation.** Existing keyboard, focus, reduced-motion, and semantic-control tests are strengths. [audit-accessibility.mjs](../scripts/audit-accessibility.mjs) mainly inspects tokens and source patterns, and the README explicitly defers the VoiceOver listening pass. The E2E configuration declares no Firefox/WebKit projects.

Add rendered DOM accessibility checks for the most important states and complete a recorded screen-reader/keyboard acceptance pass. Decide the supported browser matrix and exercise a small cross-browser critical path. Verify station discovery from visible controls: semantic station buttons intentionally have `tabIndex=-1`, so the custom navigation contract deserves real assistive-technology validation.

**Acceptance:** users can discover agents, identify blocked work, open/close details and settings, and return focus without canvas pointer input. Test zoom/narrow layout, no motion, and renderer fallback. Manual evidence names browser/AT versions and observed behavior; static regex checks are not described as full accessibility certification.

### ENG-017 — Surface test execution gaps and retain failures

**Source-confirmed.** Several socket tests in [adapter.rs](../server/src/adapter.rs) and [feed.rs](../server/src/feed.rs) return successfully when Unix socket binding gets `PermissionDenied`. The managed workflow retains a summary and manifest, but has no explicit upload for Playwright traces/screenshots even though the [E2E configuration](../e2e/playwright.config.ts) produces them.

Make required CI environments fail if a critical integration boundary cannot be exercised. Allow explicit local skips only with visible counts and reasons. Upload selected sanitized browser artifacts and useful per-step logs on failure, with short retention and size limits. Gradually replace brittle source-text assertions with parsed configuration and behavioral negative tests where they add confidence.

**Acceptance:** disabling socket permissions cannot yield a fully successful integration signal. A failing E2E run links directly to its trace/screenshot and relevant step log. Diagnostics avoid leaking private fixture data or credentials.

### ENG-018 — Make local toolchains reproducible

**Observed environment drift/source-confirmed configuration gap.** Local Vitest differs from the declared version. Node is specified in CI, Rust uses the stable toolchain action, and the managed Swamp installer is Linux-only; contributor setup does not provide one cross-platform preflight covering Node, Rust, Swamp, Deno, and installed dependency drift.

Declare supported tool versions in a small shared configuration, pin the Rust toolchain release where reproducibility requires it, and add a read-only environment check with remediation. Detect stale `node_modules` before presenting local results as release evidence. Document macOS Swamp bootstrap/certificate troubleshooting without weakening TLS verification.

**Acceptance:** a clean supported macOS/Linux checkout reaches narrow tests using the documented path. An intentionally stale install is identified before verification. CI and local commands report their actual tool versions; upgrades remain explicit and tested.

### ENG-019 — Tune specialist review using outcome data

**Proposal grounded in fixed policy.** The [factory template](../models/@swamp/software-factory/nightshift-template.yaml) invokes seven reviewers for both plan and code, with up to four cycles per review stage. The [review workflow](../workflows/workflow-nightshift-review.yaml) contains long repeated CEL expressions for lane results. An [analytics report](../extensions/reports/nightshift_review_analytics.ts) already exists, so a new telemetry system is unnecessary.

Use recorded cost, duration, unique actionable findings, overlap, and later regressions to evaluate review value. Pilot risk-based lane selection on small changes while retaining mandatory trust/security controls. Re-review affected concerns with an explicit policy for stale findings. Centralize aggregation through a typed existing extension boundary where appropriate, and consolidate the legacy/template lifecycle divergence.

**Acceptance:** a report compares token/cost and turnaround per delivered item before and after, shows coverage gaps honestly, and tracks escaped defects. Routing is deterministic and auditable; findings and human decisions remain persisted. No claim that a lane is wasteful without data.

### ENG-020 — Separate compatibility regression from discovery

**Source-confirmed.** The weekly [compatibility drift workflow](../.github/workflows/herdr-compatibility-drift.yml) checks the same immutable upstream commits. That is a good supported-matrix regression check, but it cannot discover a newly released Herdr protocol by itself.

Keep the immutable regression job. Add a read-only latest-release discovery check through the existing Swamp integration surface and surface candidates outside the supported matrix for maintainer review. Name both jobs according to what they establish.

**Acceptance:** a simulated new upstream release generates a clear discovery result; runtime support is never expanded automatically. Every accepted protocol still requires an immutable source reference and sanitized fixture.

### ENG-021 — Extract coherent scene and lifecycle modules

**Proposal.** [kitchen-scene.ts](../client/src/scene/kitchen-scene.ts) is roughly 1,800 lines; [TUI scene/mod.rs](../server/src/tui/scene/mod.rs) is roughly 2,100 including tests. They contain several coherent responsibilities. The factory template and legacy definition also duplicate much of the lifecycle.

Extract station rendering, room/freezer rendering, interaction geometry, and lifecycle bookkeeping only where existing ownership boundaries support it. Separate tests/fixtures where this improves navigation. Establish one canonical lifecycle source plus explicit migration compatibility. Avoid introducing a generic rendering framework or a new state-management stack.

**Acceptance:** existing visual/state tests pass, public APIs remain small, and representative behavior changes touch fewer unrelated sections. Refactoring does not expand the product surface or degrade measured budgets.

### ENG-022 — Align asset delivery with transfer measurements

**Source-confirmed.** [check-bundle-budget.mjs](../scripts/check-bundle-budget.mjs) reports gzip transfer estimates. [service.rs](../server/src/service.rs) serves embedded bytes without compression, ETag, or explicit cache policy, and converts borrowed bytes into a new vector for each response. Thus the gzip metric is not the current server's actual wire transfer.

First measure real cold/warm asset requests from the binary. Keep a clearly named compressed-size budget, and either implement negotiated precompressed delivery plus safe content-hash caching or use actual raw transfer for the product budget. Avoid unnecessary response copies where supported.

**Acceptance:** measured browser bytes agree with documented limits. Compressed/uncompressed requests work; HTML does not become stale across upgrades; fingerprinted assets cache correctly. Confirm effort is worthwhile for localhost use.

### ENG-023 — Make acceptance contracts reusable per release

**Source-confirmed maintenance cost.** [releasing.md](releasing.md) explains that the checked-in acceptance inputs and validator describe v0.2.0 specifically and must be replaced for the next stable release. Version identity also appears in Cargo, installer, plugin manifest, and notes, with checks to catch drift.

Separate reusable gate definitions/schema from per-release RC identity, promotion identity, and manual evidence. Provide an explicit preparation command that emits a reviewable candidate manifest and version updates. Preserve accepted historical contracts. Document the supported Linux/glibc baseline and retain build-tool identities with release artifacts.

**Acceptance:** preparing a future release changes identity data and intentional product metadata without rewriting validation logic. Old evidence cannot satisfy a new promotion. Manual gates remain manual and exact RC artifact identities remain verifiable.

### ENG-024 — Standardize missing-data and provenance semantics

**Source-confirmed.** The adapter supplies zero tickets and maps upstream unknown status to idle. Browser detail panels and the TUI detail strip render zero tickets as unavailable, but the compact [TUI table](../server/src/tui/view.rs) renders `tickets.to_string()` and therefore displays `0`. [SessionStats](../protocol/generated/agent-state-event.ts) cannot distinguish unavailable from a genuine zero.

Define explicit unavailable/observed semantics in the normalized contract, with a compatible versioning plan. Make unknown source state a conscious product decision rather than an implicit idle equivalence. Keep “Mise time” clearly defined as time observed by Mise, not upstream session lifetime.

**Acceptance:** the same fixture renders consistent availability in browser, scene TUI, and compact TUI. Genuine zero and unknown values are distinguishable, and a reconnect/restart does not imply historical knowledge the process lacks.

## Suggested sequencing and success measures

1. **Reliability first:** ENG-001 through ENG-004. These address observable wrong state or accumulating resources with focused changes and regression tests.
2. **Delivery confidence:** ENG-005 through ENG-008, plus ENG-017/018 where needed. Preserve the existing main-owned verification and human approval boundaries while closing execution gaps.
3. **Faster feedback:** ENG-009 through ENG-011 and ENG-019. Gather timings and review outcome data before changing concurrency or reviewer policy.
4. **Product hardening:** ENG-012 through ENG-016, ENG-020, and ENG-024. Ship measured improvements in recovery, latency, accessibility, and compatibility.
5. **Selective maintenance:** ENG-021 through ENG-023 when nearby work makes the changes economical.

Track source-to-screen state latency, browser memory slope with stats closed, active sockets after repeated recovery, managed verification p50/p95 and queue delay, time to first PR failure, required suites actually executed, actionable review findings per cost, escaped regressions, and release retry hash stability. Use existing Swamp reports and local diagnostic artifacts; product telemetry is unnecessary.

Before accepting this backlog, deduplicate it against current GitHub issues and verify live repository rulesets, required status contexts, environment reviewers, recent run durations, review analytics, and release retry history. Those external facts were not established by this source review.
