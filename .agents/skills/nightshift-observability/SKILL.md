---
name: nightshift-observability
description: Review Nightshift work for truthful local status, error propagation, and diagnosable Live/Demo/Disconnected/Empty behavior without adding telemetry.
---

# Nightshift Observability

Operators and users must distinguish healthy, degraded, and failed local behavior. The released product sends no telemetry and makes no outbound product network requests.

## Shared contract

Follow [the versioned review contract](../../../agent-constraints/review.md) for
output, applicability, severity, finding identity, evidence, and adjudication.
The criteria below identify this lane's concerns; apply the shared severity
rules to their actual impact.

## Fail when

- Typed `sourceStatus`, Live/Demo/Disconnected/Empty, or terminal errors collapse into generic success or silent fallback.
- Browser or TUI status surfaces stop being actionable (`DEMO SERVICE` placard, `GAS LEAK - SERVICE SUSPENDED`, `Waiting for agents - start one in herdr.`, unsupported-protocol copy with observed version and next action).
- TUI scene or compact header omits `view::status_lines` so Demo/degraded/unsupported can look live.
- Rust errors lose context across discovery, adapter, feed, service, or runtime.
- WebSocket close, parse, stale-feed (2.9s), reconnect, or resync emits untruthful store/mode transitions.
- Snapshot-before-delta, ended-immediate publish, lagged-resync, or shared `CancellationToken` shutdown is broken.
- Credentials, socket payload secrets, or invented metrics are logged.
- New outbound product network or telemetry is introduced.

## Warn when

- Copy is truthful but incomplete (a view shows connection text without Demo/empty/unsupported diagnostics).
- A local diagnostic seam exists and a structured event would help, but only if an existing consumer would read it.

## Inspect

- `server/src/{feed.rs,adapter.rs,service.rs,discovery.rs,runtime.rs,demo.rs}`.
- `server/src/tui/view.rs` `status_lines` and every scene/compact caller.
- `client/src/state/{store.ts,ws-client.ts}`, `client/src/chrome` mode treatments.
- Heartbeat is liveness only - it must not mutate `AgentStore` or `lastUpdateAt`.

## False positives

- Do not demand OpenTelemetry, spans, metrics backends, or dashboards.
- `Unavailable` for missing feed fields is correct. Invented numbers are the defect.
- Demo roster while retrying a missing socket is required, and must stay labeled Demo.
- Hosted smoke is a factory stage after merge, not this lane.

## Exclude

Test completeness, code style, UI composition, bounded contexts, exploitability, WCAG - except where an error is hidden or misreported.
