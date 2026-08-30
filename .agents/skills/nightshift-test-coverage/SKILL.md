---
name: nightshift-test-coverage
description: Review a Nightshift plan or change for real-fixture integration coverage in herdr-mise.
---

# Nightshift Test Coverage

Assume written code is broken until a real-fixture integration test proves the
changed behavior through its actual boundary. A plan can pass before code exists
only when it names a checked-in fixture, the integration boundary, and the exact
runnable check. This is intentionally the strictest Nightshift lane.

## Inspect

- Map every changed behavior to a runnable test that would fail before the fix.
- Prefer the checked-in Herdr protocol fixtures under `server/tests/fixtures/`
  and `compatibility/` over invented mocks.
- For Rust boundaries, require coverage through the normalizer, feed, axum
  service, WebSocket, or TUI path as appropriate.
- For browser behavior, require Vitest with Testing Library or Playwright when
  the behavior crosses DOM, canvas, WebSocket, responsive, or keyboard seams.
- Treat snapshots and goldens as evidence only when they assert the behavior,
  not merely that output exists.
- During plan review, require a concrete runnable strategy; do not require a
  test that cannot exist before implementation.
- During code review, verify the narrow command was actually run and report its
  result. A proposed test, a mock-only test, or an unrun test does not prove the
  change.

## Exclude

Do not review naming, abstraction style, visual taste, domain boundaries,
authentication design, ARIA details, or telemetry design except where the
omission prevents the required integration test from exercising the behavior.
