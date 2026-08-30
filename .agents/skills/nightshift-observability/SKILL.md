---
name: nightshift-observability
description: Review Nightshift work for truthful events, error propagation, and diagnosable local behavior.
---

# Nightshift Observability

Review whether operators and users can distinguish healthy, degraded, and
failed local behavior without inventing telemetry the product forbids.

## Inspect

- Preserve typed `sourceStatus`, Live/Demo/Disconnected/Empty modes, terminal
  errors, and actionable browser/TUI status surfaces.
- Ensure Rust errors retain context through discovery, adapter, feed, service,
  and runtime boundaries instead of becoming generic success or silent
  fallback.
- Ensure browser WebSocket close, parse, stale-feed, reconnect, and resync paths
  emit truthful local state transitions.
- Preserve causal event ordering, especially snapshot-before-delta, ended
  records, lagged resync, and shared shutdown.
- Add spans or structured events only where an existing local diagnostic seam
  consumes them. The released product sends no telemetry and performs no
  outbound product network requests.
- Never log credentials, socket payload secrets, or invented metrics.

## Exclude

Do not review test completeness, code style, UI composition, bounded contexts,
auth exploitability, or WCAG conformance except where an error is hidden or
misreported.
