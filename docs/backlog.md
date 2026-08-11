# herdr-mise — implementation backlog

> Status: originating audit record for the initial release-candidate cycle; not
> the live roadmap
>
> Product authority: [README.md](../README.md)
>
> Architecture authority: [architecture.md](architecture.md)
>
> Operational and release authority: [operations.md](operations.md)

This document preserves the evidence, proposed work, acceptance criteria, and
validation commands produced by the initial `v0.1.0-rc.1` audit. It prioritizes
one product outcome:
herdr-mise must be a truthful, reliable, low-attention view of local Herdr
agents, with blocked work unmistakable from across the room.

[GitHub issues](https://github.com/funsaized/herdr-mise/issues) are the current
roadmap authority; their discussion, ownership, milestone, and status supersede
this audit snapshot. BL-001 through BL-004 are tracked by
[PR #16](https://github.com/funsaized/herdr-mise/pull/16) to avoid duplicating
completed or in-flight work. BL-005 onward are tracked by their matching GitHub
issues. This record must not accumulate issue comments or duplicate live status.

## Product loop to protect

```text
Start Herdr + herdr-mise
          |
          v
A truthful live kitchen appears
          |
          v
The kitchen stays visible all day
          |
          v
A blocked agent becomes unmistakable
          |
          v
The user resolves the prompt in Herdr
          |
          v
The kitchen visibly returns to work
```

The project remains localhost-only, read-only, single-machine, and intentionally
narrow. A feature that does not improve activation, truthful state projection,
blocked-state recognition, all-day reliability, or sustainable open-source
maintenance needs unusually strong evidence to enter this backlog.

## How to pick up an item

1. Confirm the item is not already represented by an open GitHub issue or PR.
2. Create or claim the matching issue and record any changed assumptions.
3. Branch from current `main`; use one branch and PR per backlog item.
4. Write the regression test first for behavioral changes.
5. Preserve these invariants:
   - bind only to `127.0.0.1`;
   - never control or mutate Herdr;
   - never invent unavailable feed data;
   - keep demo mode persistently labeled;
   - do not weaken WebSocket origin checks;
   - do not reduce blocked-state salience;
   - retain all current performance budgets.
6. Run the item-specific checks, then the standard gates from
   [CONTRIBUTING.md](../CONTRIBUTING.md#before-you-open-a-pr).
7. Include before/after evidence for user-visible or performance-sensitive work.
8. Keep commits focused and leave unrelated cleanup for another issue.

## Sequencing

```text
v0.1.0-rc.2
  BL-001 empty-agent correctness
      |
      +--> BL-002 startup recovery and diagnostics
      |
      +--> BL-003 activation-oriented quick start
      |
      +--> BL-004 establish public backlog

v0.1.0 stable
  BL-005 stable release semantics -------------------+
  BL-006 stable acceptance contract <--- BL-001/002 --+
  BL-007 reduced motion and accessibility
  BL-008 Herdr compatibility contract <--- BL-001/002
  BL-009 CI supply-chain baseline
  BL-010 source readability and formatting

post-v0.1
  BL-011 static public playground <--- BL-007
  BL-012 repository positioning and upstream listing
  BL-013 installation and opt-in startup service <--- BL-005/006
  BL-014 loopback port override
```

Items are ordered within each milestone. `P0` blocks promotion from that
milestone; `P1` should ship in the milestone unless evidence justifies moving
it; `P2` is explicitly non-blocking.

---

# Milestone: v0.1.0-rc.2

## BL-001 — Keep non-agent panes out of an empty kitchen

- **Status:** Complete
- **Priority:** P0
- **Area:** adapter, protocol
**Outcome:** An empty Herdr agent list renders the empty-kitchen state, not
ordinary terminal panes as idle cooks.

### Evidence

`server/src/adapter.rs::normalize_snapshot` falls back to `raw.panes` whenever
`raw.agents` is empty. Unknown agent status then maps to `idle`. In Herdr
protocol 19, a snapshot may contain ordinary panes whose `agent_status` is
`unknown`; those panes are not agents and must not become cooks.

### Likely files

- Modify: `server/src/adapter.rs`
- Modify/add fixtures: `server/tests/fixtures/`
- Possibly update: `docs/operations.md`

### Implementation plan

1. Add a sanitized protocol-19 fixture with `agents: []` and one or more
   non-agent panes.
2. Add a failing adapter test asserting that normalization produces zero
   agents and zero ended IDs.
3. Determine whether protocol 17 genuinely requires pane fallback.
4. If fallback is required, branch on the source protocol and positively
   identify agent panes using stable agent/session metadata. Do not accept all
   panes merely because the agent list is empty.
5. Preserve the current behavior for an actual agent whose status is
   temporarily `unknown`.
6. Add a regression test for both supported protocols.

### Acceptance criteria

- A protocol-19 snapshot with no agents and ordinary panes produces an empty
  normalized agent map.
- The browser shows `Waiting for agents — start one in herdr.`
- Real unknown-status agents remain visible as idle rather than being removed.
- Protocol-17 and protocol-19 fixture tests pass.
- No invented agent name, workspace, runtime, ticket, or model data is emitted.

### Validation

```sh
cargo test --workspace --locked adapter
npm test
```

**Dependencies:** none. This is the first implementation item.

---

## BL-002 — Recover automatically from demo startup to a live Herdr feed

- **Status:** Complete
- **Priority:** P0
- **Area:** feed, adapter, client chrome
**Outcome:** Starting herdr-mise before Herdr no longer requires restarting
herdr-mise, and the UI reports the real failure reason.

### Pre-implementation evidence

Before BL-002 was implemented, `server/src/feed.rs::Feed::start` permanently
selected `run_demo` after any startup discovery, connection, request, or
normalization error, and `server/src/feed.rs::run_demo` never probed the source
again. The client then hardcoded `Mock feed — no herdr socket found` even when
the actual failure was a timeout, unsupported protocol, remote error, or
malformed response.

The RC audit reproduced that pre-implementation behavior: the process started
in demo mode, a valid Herdr socket was made available, and the process remained
in demo mode. The current implementation and completion evidence below replace
this behavior.

### Likely files

- Modify: `server/src/feed.rs`
- Modify: `server/src/adapter.rs`
- Modify: `server/src/protocol.rs`
- Modify: `client/src/chrome/Chrome.tsx`
- Modify: `client/src/state/store.ts`
- Modify: generated protocol/schema only if a typed source-status field is added
- Add tests beside the changed feed, service, store, and chrome code
- Update: `docs/architecture.md`, `docs/operations.md`, `README.md`

### Implementation plan

1. Introduce a typed, non-sensitive source status/failure reason. Keep it
   separate from agent data.
2. Model at least: unavailable socket, timeout, unsupported protocol,
   malformed/incompatible response, and connected/live.
3. Add a retry loop with bounded exponential backoff and a reasonable ceiling.
4. Cancel retries immediately during shutdown.
5. On successful discovery, obtain and normalize a fresh snapshot before
   switching from demo to live.
6. Broadcast the live snapshot atomically so demo cooks do not leak into the
   live roster.
7. Continue to recover from source loss using the existing snapshot-first
   reconnect contract.
8. Render a concise, truthful placard for the current source condition.
9. Avoid logging raw payloads, agent names, workspace paths, or full socket paths
   by default.

### Acceptance criteria

- Starting without Herdr enters clearly labeled demo mode.
- Making a compatible Herdr socket available later changes the same process to
  live mode without a browser or server restart.
- Removing and restoring the source recovers through a fresh snapshot.
- Unsupported protocol is distinguishable from a missing socket.
- The retry loop is bounded, does not busy-spin, and exits on shutdown.
- WebSocket snapshot-before-delta ordering remains intact.
- Demo data is never presented as live data.

### Validation

```sh
cargo test --workspace --locked feed
npm test
npm run smoke
npm run measure:server
npm run validate:release
```

Add an automated integration test that reproduces the exact
missing-source-then-live-source lifecycle.

### Completion evidence

`FeedState` now atomically owns mode, typed source status, and roster. Startup
uses a cancellation-aware exponential retry loop capped at 4 s; successful
startup or source-loss recovery installs a freshly normalized authoritative
snapshot before broadcasting or restoring health. The shared schema, Rust and
TypeScript bindings, golden fixture, store, and chrome carry truthful
non-sensitive source statuses. Feed tests cover missing-source-to-live recovery,
paused-time backoff/shutdown, atomic replacement, source restoration, and wire
coalescing; component tests distinguish an unavailable socket from an
unsupported protocol.

**Dependencies:** implement after or alongside BL-001 so the recovered initial
snapshot is projected correctly.

---

## BL-003 — Put a real Herdr-to-live-kitchen quick start at the top of README

- **Priority:** P0
- **Area:** documentation, activation
**Outcome:** A user who has never seen the repository can reach a truthful live
kitchen in less than five minutes.

### Evidence

The current prerequisites name Herdr protocol versions but do not link to Herdr
or explain how to install/start it. herdr-mise installation appears after the
architecture and contributor sections. Demo fallback can therefore look like a
successful installation even though the core product loop was never activated.

### Likely files

- Modify: `README.md`
- Modify: `docs/operations.md`
- Possibly modify: `SECURITY.md` for a supported-version table

### Implementation plan

1. Place a compact `Quick start` immediately after the hero/product summary.
2. Link to:
   - `https://herdr.dev`
   - `https://herdr.dev/docs/install`
   - `https://github.com/herdrdev/herdr`
3. State the exact tested Herdr release/protocol compatibility matrix.
4. Show install, checksum verification, execution, browser URL, and
   live-versus-demo recognition.
5. Keep detailed platform commands in `docs/operations.md`; avoid duplicating
   long command blocks in README.
6. Clarify whether herdr-mise is official, affiliated, or an independent
   community project. Do not guess the relationship.
7. Add troubleshooting links for source unavailable and unsupported protocol.

### Acceptance criteria

- A clean-machine walkthrough reaches `mode=live` in under five minutes on a
  supported platform.
- The README never implies that demo mode is a successful live connection.
- All local and external links resolve.
- Version claims match adapter constants and fixtures.
- Installation examples contain no personal deployment identifiers.

### Validation

```sh
npm test
npm run validate:release
```

Also run a Markdown link checker over project-authored documentation and perform
one manual clean-directory installation using the public RC.

**Dependencies:** documentation should describe the final behavior from BL-002,
so merge BL-002 first or coordinate the wording in the same milestone.

---

## BL-004 — Establish a small public backlog and milestone system

- **Priority:** P0
- **Area:** open source, governance
**Outcome:** Contributors can see what is accepted, what blocks the next
release, and which tasks are safe to pick up.

### Evidence

The repository has issue templates and says GitHub issues are the accepted
roadmap, but the RC audit found zero real issues and zero milestones. Existing
labels are mostly GitHub defaults and dependency categories.

### Implementation plan

1. Create milestones `v0.1.0-rc.2`, `v0.1.0`, and `post-v0.1`.
2. Add only the minimal labels needed for triage:
   - `priority:p0`, `priority:p1`, `priority:p2`
   - `area:adapter`, `area:client`, `area:release`, `area:docs`, `area:oss`
3. Create one issue per accepted backlog item using the matching `BL-NNN` ID.
4. Put acceptance criteria and validation commands in every issue.
5. Add `good first issue` only after an item is genuinely bounded and documented.
6. Close or re-scope this document after GitHub issues become authoritative; do
   not maintain two diverging roadmaps indefinitely.

### Acceptance criteria

- Every accepted P0/P1 item has one issue, priority, area, milestone, owner or
  explicit `help wanted` status, and acceptance criteria.
- Milestone descriptions state promotion rules.
- No duplicate issues are created for existing PR work.
- `CONTRIBUTING.md` names the issue tracker as the current authority and links to
  this document only as the originating audit backlog.

### Validation

Review the issue list logged out or in an anonymous browser. Confirm that a new
contributor can identify the next unclaimed task without repository history.

**Dependencies:** requires maintainer approval because it publishes GitHub
issues and changes repository metadata.

---

# Milestone: v0.1.0 stable

## BL-005 — Publish stable tags as stable releases

- **Priority:** P0
- **Area:** release engineering
**Outcome:** A stable SemVer tag produces a non-prerelease GitHub release only
after stable gates pass.

### Evidence

The current release workflow passes `--prerelease` unconditionally. A
`v0.1.0` tag would therefore still produce a prerelease. The current support
policy refers to the latest release, while GitHub has no latest stable release.

### Likely files

- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release-contract.test.mjs`
- Modify: `docs/operations.md`
- Modify: `SECURITY.md`
- Modify version references in `server/Cargo.toml`, `Cargo.lock`, and README when
  preparing an actual release

### Implementation plan

1. Parse and validate the tag as SemVer.
2. Treat tags with prerelease suffixes as prereleases.
3. Treat stable SemVer tags as stable only after the BL-006 gate is recorded.
4. Keep publication tag-triggered, exact-asset, fail-closed, and post-publish
   reverified.
5. Add contract tests for RC and stable tags.
6. Document version bump, tag, publication, rollback, and support-policy steps.
7. Curate release notes rather than publishing unedited generated notes.

### Acceptance criteria

- `v0.1.0-rc.2` is marked prerelease.
- `v0.1.0` is not marked prerelease and becomes GitHub `Latest`.
- Invalid or mismatched tags fail before signing/publication.
- All six expected assets are publicly downloaded and verified.
- Stable release notes include purpose, install link, Herdr compatibility, known
  limitations, and checksums.
- `SECURITY.md` names supported stable and prerelease versions unambiguously.

### Validation

```sh
npm test
npm run validate:release
```

Exercise both tag classes in a non-publishing contract test. Do not test stable
publication by creating a public release.

**Dependencies:** BL-006 defines the stable gate.

---

## BL-006 — Define and execute the RC-to-stable acceptance contract

- **Priority:** P0
- **Area:** release, product acceptance
**Outcome:** Stable promotion is based on recorded product evidence, not merely
a green build.

### Likely files

- Modify: `docs/operations.md`
- Modify: `.github/pull_request_template.md` or add a focused release checklist
- Modify scripts only where a gate can be deterministic

### Required gate

Before stable promotion, record all of the following against the public RC:

1. Install the downloaded artifact, not a source-tree binary.
2. Verify live mode against the current supported Herdr stable release.
3. Verify start-without-source then automatic live recovery.
4. Verify source loss and fresh-snapshot recovery.
5. Verify no-agent snapshots with non-agent panes.
6. Verify 1, 6, and 12 agents in light and dinner themes.
7. Verify blocked-state recognition from at least two meters.
8. Verify keyboard and VoiceOver behavior.
9. Verify reduced-motion behavior.
10. Complete a multi-day all-day resource soak.
11. Test upgrade and uninstall instructions.
12. Confirm no unresolved P0 issues in the stable milestone.

### Acceptance criteria

- Automated gates have exact commands and captured output.
- Manual gates identify tester, platform, artifact checksum, and result.
- A scoped subsystem pass cannot override a failed full-product gate.
- Stable publication remains blocked until all required evidence passes.
- Exceptions require an explicit documented owner decision and cannot weaken
  localhost, read-only, truthfulness, or blocked-state invariants.

### Validation

Use `npm run validate:release`, `npm run perf`, checksum verification, the
public-artifact verifier, and the documented manual matrix. Store no agent names,
workspace paths, or private Herdr payloads in public evidence.

**Dependencies:** BL-001, BL-002, BL-005, BL-007, and BL-008.

---

## BL-007 — Honor reduced motion and complete accessibility acceptance

- **Priority:** P1
- **Area:** client, accessibility
**Outcome:** Motion-sensitive and assistive-technology users can operate the
visualizer without losing blocked-state clarity.

### Evidence

The client has semantic station labels, contrast checks, keyboard behavior, and
focus-restoration tests, but no `prefers-reduced-motion` implementation was
found. Settings and detail panels require manual VoiceOver/focus validation.

### Likely files

- Modify: `client/src/scene/kitchen-scene.ts`
- Modify: `client/src/scene/idle-poses.ts`
- Modify: `client/src/theme/global.css`
- Modify: `client/src/chrome/Chrome.tsx`
- Modify tests under `client/src/` and `e2e/`
- Update: `README.md`, `docs/operations.md`

### Implementation plan

1. Represent system reduced-motion preference in the client runtime.
2. Stop decorative idle poses, particles, and nonessential movement when
   reduced motion is requested.
3. Replace motion-dependent blocked escalation with a static, high-contrast
   signal that retains words and shape.
4. Test preference changes at runtime.
5. Manually verify settings and detail panel roles, initial focus, escape,
   restoration, and announcements with VoiceOver.
6. Add focused Playwright assertions for the behavior that can be automated.

### Acceptance criteria

- `prefers-reduced-motion: reduce` removes decorative continuous motion.
- Blocked agents remain unmistakable without pulse or travel animation.
- No information is encoded solely through color or motion.
- All controls remain keyboard operable.
- Settings/detail focus behavior has recorded VoiceOver acceptance evidence.
- Existing contrast, visual matrix, and performance gates pass.

### Validation

```sh
npm run audit:accessibility
npm test
npm run test:visual
npm run perf
```

**Dependencies:** complete before BL-006 stable acceptance.

---

## BL-008 — Make Herdr compatibility an explicit maintained contract

- **Priority:** P1
- **Area:** adapter, protocol, maintenance
**Outcome:** Upstream Herdr changes produce an actionable compatibility signal
instead of silently breaking first-run activation.

### Likely files

- Modify: `server/src/adapter.rs`
- Add/update: `server/tests/fixtures/`
- Modify: `README.md`, `docs/architecture.md`, `docs/operations.md`
- Add a scheduled non-publishing workflow only if it can be deterministic and
  low-noise

### Implementation plan

1. Publish a Herdr release-to-protocol compatibility table.
2. Keep a sanitized fixture for each supported stable protocol.
3. Test unsupported-protocol diagnostics explicitly.
4. Define when old protocol support can be removed.
5. Add a scheduled check of the latest stable Herdr release/schema. It should
   report drift without tracking upstream `main` as a release blocker.
6. Ensure all fixtures contain fictional names and paths.

### Acceptance criteria

- Every claimed compatible protocol has a fixture and adapter test.
- Unsupported versions fail with a truthful, actionable reason.
- Scheduled drift checks are non-publishing, deterministic, and do not expose
  credentials or private payloads.
- Documentation and adapter constants cannot drift unnoticed.

### Validation

```sh
cargo test --workspace --locked adapter
npm test
```

**Dependencies:** incorporate BL-001/BL-002 source semantics first.

---

## BL-009 — Add the low-cost software-supply-chain baseline

- **Priority:** P1
- **Area:** CI, security, release
**Outcome:** Pull requests receive source and dependency security checks, and
workflow dependencies are immutable.

### Likely files

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Add: `.github/workflows/codeql.yml` if a separate workflow is clearer
- Use existing: `.gitleaks.toml`
- Modify: `.github/dependabot.yml`
- Update: `docs/operations.md`

### Implementation plan

1. Set explicit minimal workflow permissions, including `contents: read` in CI.
2. Pin Actions to full commit SHAs and retain version comments.
3. Configure Dependabot to update action pins.
4. Add CodeQL for Rust and JavaScript/TypeScript.
5. Add pull-request dependency review.
6. Run gitleaks in CI using the existing allowlist.
7. Add `cargo audit` or `cargo deny` with a documented advisory policy.
8. Set timeouts and concurrency cancellation for non-release CI.

### Acceptance criteria

- No workflow Action uses only a mutable tag.
- CI tokens have explicit least-privilege permissions.
- Source, secret, and dependency checks are required or clearly reported.
- Existing RFC/test allowlists stay narrow and documented.
- Fork PRs do not receive release secrets or write permissions.
- CI remains reproducible from committed lockfiles.

### Validation

Run the workflows on a pull request and inspect permissions/results. Add safe
fixtures to prove scanners run; never commit a real secret.

**Post-stable follow-up:** SBOMs, GitHub artifact attestations, and provenance
verification can be a separate P2 item. Do not block RC.2 on full SLSA work.

---

## BL-010 — Adopt deterministic formatting and split contributor hotspots

- **Priority:** P1
- **Area:** maintainability, contributor experience
**Outcome:** A new contributor can review and modify the client without parsing
large one-line functions.

### Evidence

Several TypeScript hotspots contain substantial state and rendering logic on
very long lines, particularly `App.tsx`, `Chrome.tsx`, `store.ts`,
`ws-client.ts`, and `kitchen-scene.ts`. Lint currently accepts this style, but
it increases review and blame cost.

### Likely files

- Modify: root/client package manifests and lockfiles if adding a formatter
- Modify: client TypeScript/TSX files in one isolated formatting commit
- Modify: `.github/workflows/ci.yml`
- Update: `CONTRIBUTING.md`

### Implementation plan

1. Select one deterministic formatter already compatible with the toolchain.
2. Add `format` and `format:check` scripts.
3. Apply formatting in a behavior-free commit.
4. Add the check to CI.
5. In later focused commits, split only components/functions with a clear
   ownership boundary; do not combine architecture changes with bulk formatting.
6. Preserve generated files according to their generator rather than manually
   formatting them into drift.

### Acceptance criteria

- Formatting is deterministic locally and in CI.
- The initial formatting commit contains no intentional behavior change.
- Existing unit, browser, bundle, and performance gates pass.
- Contributor instructions include the format command.
- Subsequent blame can ignore the formatting commit where supported.

### Validation

```sh
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:visual
npm run check:bundle
```

**Dependencies:** none, but merge after urgent RC.2 correctness work to minimize
conflicts.

---

# Milestone: post-v0.1

## BL-011 — Publish a static, truthful visual playground

- **Priority:** P1
- **Area:** activation, client, documentation
**Outcome:** Prospective users can understand the product without installing it
or granting access to a local Herdr socket.

### Scope

Build on the deterministic visual harness. The hosted build must never connect
to localhost or persist settings, and must retain the non-dismissible demo
placard.

### Acceptance criteria

- Static deployment supports light/dinner themes, all states, and 1–12 agents.
- Hosted code cannot connect to Herdr or other local services.
- Demo status is always visible.
- GitHub Pages deployment is least-privilege and reproducible.
- Page metadata includes title, description, favicon, and a custom social
  preview.
- Accessibility and visual-matrix tests run against the deployed-mode build.

### Validation

```sh
npm run build -- --mode visual
npm run test:visual
npm run audit:accessibility
```

**Dependencies:** BL-007.

---

## BL-012 — Correct repository positioning and pursue an upstream listing

- **Priority:** P1
- **Area:** open source, discoverability
**Outcome:** GitHub visitors understand exactly what herdr-mise does and can
find it through the Herdr ecosystem without implying unsupported capabilities.

### Implementation plan

1. Replace misleading topics such as `mosh`, `ssh`, and `swarm` with accurate
   terms such as `ai-agents`, `agent-monitoring`, `visualizer`, `pixel-art`,
   `pixijs`, `localhost`, and `developer-tools`.
2. Keep `herdr-plugin` only if the upstream ecosystem defines this product as a
   plugin.
3. Set the repository homepage to the static playground when BL-011 ships.
4. Use a custom social preview based on accepted product media.
5. After stable acceptance, request an upstream Herdr community-project or
   integration listing.

### Acceptance criteria

- Metadata describes actual shipped behavior.
- Affiliation with Herdr is explicit and accurate.
- No external post, issue, or PR is made without maintainer approval.
- README and repository metadata use the same concise positioning.

**Dependencies:** upstream outreach waits for BL-005 and BL-006.

---

## BL-013 — Reduce installation and opt-in all-day startup friction

- **Priority:** P1
- **Area:** distribution, operations
**Outcome:** Stable users can install, upgrade, uninstall, and explicitly opt
into launch-on-login without copying long archive commands.

### Implementation plan

1. Publish the stable artifact contract first.
2. Add a Homebrew formula or tap for supported macOS targets.
3. Verify checksum, code signature, notarization, install, upgrade, and
   uninstall paths.
4. Add an explicit reversible service interface or Homebrew-services contract.
5. Never silently install or start a background service.
6. Keep the service loopback-only and read-only.

### Acceptance criteria

- Install, upgrade, service start/stop, and uninstall are documented and tested.
- Launch-on-login requires an explicit user action.
- Removing the service leaves no running process or stale launch configuration.
- Distribution references immutable release assets and verifies trust material.

**Dependencies:** BL-005 and BL-006.

---

## BL-014 — Allow the loopback port to be overridden safely

- **Priority:** P2
- **Area:** server, operations
**Outcome:** Port collisions do not make the product unusable, while the
localhost security boundary remains fixed.

### Likely files

- Modify: `server/src/main.rs`
- Modify: `server/src/service.rs`
- Modify server tests
- Update: `README.md`, `docs/architecture.md`, `docs/operations.md`

### Implementation plan

1. Add one validated configuration input, preferably `HERDR_MISE_PORT`.
2. Continue binding only to `127.0.0.1`; do not add a host override.
3. Derive default allowed origins and startup URL from the effective port.
4. Fail closed on malformed, privileged, or unavailable port values with an
   actionable message.
5. Preserve explicit extra-origin opt-in behavior.

### Acceptance criteria

- Default behavior remains `127.0.0.1:8686`.
- A valid alternate port serves the SPA and WebSocket.
- Origin policy follows the selected loopback port.
- Invalid configuration exits nonzero without binding another interface.
- Port-collision behavior has a regression test.

### Validation

```sh
cargo test --workspace --locked service
npm run smoke
npm run validate:release
```

**Dependencies:** none; intentionally post-stable unless real collision reports
justify promotion.

---

# Explicit non-goals

Do not add these during the initial stable cycle without a new product decision:

- controlling, prompting, approving, killing, or attaching to agents;
- terminal output, transcript, or log viewing;
- notifications or inbox behavior;
- multi-host aggregation or public-interface binding;
- authentication, remote tenancy, or reverse-proxy support;
- default telemetry;
- invented model, runtime, progress, or ticket values;
- Windows support while the source contract is Unix-socket based;
- additional themes, mascots, or decorative animation before activation and
  recovery are reliable;
- code splitting solely to silence Vite's raw-chunk warning while compressed
  bundle and startup budgets pass;
- reviewer requirements or CODEOWNERS rules that a solo-maintainer project
  cannot actually satisfy.

# Backlog maintenance rules

- GitHub issues become authoritative once created; this document should not
  accumulate issue comments or duplicate live status.
- Update priority only with evidence: user impact, release risk, observed
  failure frequency, or changed upstream compatibility.
- A closed item must link to its merged PR and retain the acceptance evidence on
  the issue or PR.
- Rejected items move to an explicit decision record or are closed with a short
  reason; do not leave ambiguous stale tasks.
- Before stable publication, archive or replace this proposal with a concise
  roadmap link so the public tree does not preserve a stale iteration snapshot.
