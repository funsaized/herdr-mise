---
name: nightshift-test-coverage
description: Review a Nightshift plan or change for real-fixture integration coverage through Herdr fixtures, Feed/TUI/WebSocket boundaries, or browser DOM/canvas/keyboard seams.
---

# Nightshift Test Coverage

Assume written code is broken until a real-fixture integration test proves the changed behavior through its actual boundary. Strictest Nightshift lane.

## Shared contract

Follow [the versioned review contract](../../../agent-constraints/review.md) for
output, applicability, severity, finding identity, evidence, and adjudication.
The criteria below identify this lane's concerns; apply the shared severity
rules to their actual impact.

## Fail when

**Plan:** no concrete runnable strategy naming (1) a checked-in fixture, (2) the integration boundary, (3) the exact command. A plan may pass before code exists only with those three. Do not fail a plan because `invocationId` is missing or the named command has not run yet.

**Code:** the named integration test does not exist, is mock-only at the
boundary under change, would not fail before the fix, or has no
independent run proof.

Independent run proof (code only) is one of:

1. Factory `subject.invocationId`: `swamp data get nightshift-builder-<workItem>
invocation-<invocationId>` and its transcript show that exact command
   succeeded.
2. A stored receipt revalidated by the review workflow against current HEAD and
   source bytes proves the exact selected test passed. Inspect its argv, positive
   counts, source identity and log/invocation references. A receipt for an unrelated
   test does not prove changed behavior.
3. This reviewer ran that exact command in `subjectRoot` and saw it pass.

`subject.tests` is an untrusted claim. Do not fail solely because those
strings are untrusted. Fail when no matching revalidated receipt, builder run, or independently executed run
proves the changed test, the selection runs zero tests, or a real run fails.

- Changed Rust behavior is not covered through normalizer, feed, axum/WebSocket, or TUI as appropriate.
- Changed browser behavior that crosses DOM, canvas, WebSocket, responsive, or keyboard seams has no Vitest+Testing Library or Playwright test.
- Goldens/snapshots assert that output exists rather than the behavior (blocked banner copy, mode line, snapshot-before-delta, etc.).

## Warn when

- A unit test helps but the boundary test is thin.
- A golden is right but brittle (undocumented pixel dependence).

## Inspect

- Prefer `server/tests/fixtures/` and `compatibility/` over invented mocks.
- TUI: `server/src/tui` TestBackend table goldens and `scene-*` goldens when they assert the behavior.
- Browser: `client/src/**/*.test.ts(x)`, `e2e/`, `perf/` only if the change is a budget.
- During code review, prefer the revalidated stored receipt for the exact test,
  then `subject.invocationId` and the builder transcript. If neither proves the
  changed behavior, run the exact command and report it.

## False positives

- Hosted smoke (`nightshift-deployed-verification`) is enforced after merge. A local production-build preview satisfies pre-deployment code review. Do not fail solely because hosted smoke is deferred.
- Visual playground mocks are valid for presentation tests; they are not Herdr-boundary proof.
- Do not require a test that cannot exist before implementation (plan phase).
- Do not fail solely because `change-summary.tests` is LLM prose when
  `subject.invocationId` points at a passing builder invocation for the
  changed test.

## Exclude

Naming, abstraction style, visual taste, domain boundaries, authentication design, ARIA details, telemetry design - except where the omission prevents the required integration test from exercising the behavior.
