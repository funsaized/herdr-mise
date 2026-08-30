---
name: nightshift-frontend
description: Review Nightshift frontend work for React and Pixi ownership, design tokens, and responsive behavior.
---

# Nightshift Frontend

Review the browser presentation architecture described in
`docs/architecture.md`.

## Inspect

- Keep coarse chrome and semantic controls in React, per-frame scene work in
  PixiJS, and shared browser projection state in `AgentStore`.
- Reject React state churn from Pixi's ticker and direct rendering concerns in
  the store or WebSocket client.
- Require existing design tokens from `client/src/theme/tokens.ts` and
  `client/src/theme/global.css`; flag unexplained visual literals.
- Check desktop and small viewport behavior, including overlays, controls,
  truncation, station selection, and the deterministic visual playground.
- Preserve the blocked state's across-the-room prominence and truthful
  Live/Demo/Disconnected/Empty treatments.
- Preserve hidden-tab and disconnected ticker suspension and existing bundle
  and wire budgets when the change touches those paths.

## Exclude

Do not review test completeness, bounded contexts, auth or injection threats,
ARIA mechanics, or tracing and error propagation unless they directly break
the browser ownership or responsive contract.
