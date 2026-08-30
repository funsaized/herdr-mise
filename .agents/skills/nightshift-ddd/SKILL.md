---
name: nightshift-ddd
description: Review Nightshift work for herdr-mise bounded contexts, ownership, and layer separation.
---

# Nightshift DDD

Review ownership and boundaries, not naming preferences.

## Inspect

- Herdr owns live agent truth; `Normalizer` owns protocol translation; `Feed`
  owns the atomic server projection; `AgentStore` owns the browser projection
  and local UI history.
- Keep kitchen concepts out of the Rust server and protocol. They are a client
  presentation theme.
- Keep Herdr protocol-version handling in the adapter and checked-in
  compatibility registry rather than leaking version branches downstream.
- Preserve snapshot-before-delta and one-write mode/status/roster transitions.
- Keep React chrome, Pixi scene, transport, projection state, and TUI rendering
  in their documented layers.
- Reject duplicate sources of truth and cross-layer mutation that bypasses the
  owning aggregate or projection.

## Exclude

Do not review formatting, abstraction count, visual polish, test quantity,
security exploit paths, WCAG details, or telemetry coverage unless the issue is
specifically a boundary ownership violation.
