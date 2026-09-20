---
name: nightshift-clean-code
description: Review a Nightshift plan or change for scope, dead code, premature abstraction, and misplaced constants across browser tokens and TUI theme.
---

# Nightshift Clean Code

Smallest maintainable implementation of the accepted GitHub issue. Nothing else.

## Shared contract

Follow [the versioned review contract](../../../agent-constraints/review.md) for
output, applicability, severity, finding identity, evidence, and adjudication.
The criteria below identify this lane's concerns; apply the shared severity
rules to their actual impact.

## Fail when

- Scope exceeds the GitHub issue, or code has no current caller.
- A new helper/abstraction appears where an existing shared path, stdlib feature, or installed dependency already works.
- One-implementation interfaces, speculative factories, compatibility shims without a shipped consumer, or configuration for values that do not vary.
- Visual constants scatter outside `client/src/theme/tokens.ts` / `global.css` (browser) or `server/src/tui/theme.rs` (pane). Compatibility facts scatter outside `compatibility/herdr.json`. Protocol facts scatter off the adapter/protocol boundary.
- Comments restate what the code does.
- Parallel guards in callers instead of one root-cause fix on the shared path.

## Warn when

- A magic number is local and stable but should move to tokens/theme on the next touch.
- A `ponytail:` comment names a real ceiling without an upgrade path.

## Inspect

- Diff vs the issue. Grep callers before flagging duplication.
- `client/src/theme/tokens.ts`, `server/src/tui/theme.rs`, `compatibility/herdr.json`, `server/src/adapter.rs`, `protocol/`.

## False positives

- TestBackend / scene goldens are evidence, not new abstractions.
- TUI sprites and browser geometry do not have to share code. Dual representation is the architecture.
- `ponytail:` comments that name a ceiling are allowed.
- Deleting code is in-lane.

## Exclude

Visual composition, responsive behavior, aggregate boundaries, test sufficiency, exploitability, accessibility, observability.
