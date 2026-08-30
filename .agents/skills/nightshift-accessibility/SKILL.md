---
name: nightshift-accessibility
description: Review Nightshift browser work against WCAG 2.1 AA and the project's canvas accessibility contract.
---

# Nightshift Accessibility

Review WCAG 2.1 AA behavior across React chrome and the Pixi-backed scene.

## Inspect

- Verify every interactive action is keyboard reachable with visible focus and
  predictable Escape behavior.
- Preserve `SemanticStationControls` as the semantic counterpart to canvas
  stations; canvas pixels alone are never an accessible control or status.
- Check names, roles, states, relationships, live-region behavior, and that
  ARIA does not duplicate or contradict visible truth.
- Check text and non-text contrast, blocked/error distinction, and hit targets
  at desktop and narrow viewport sizes.
- Honor reduced motion and ensure animation is not the only carrier of state.
- Run `npm run audit:accessibility` when relevant and require an interaction
  test for behavior the static audit cannot prove.

## Exclude

Do not review general component architecture, visual taste, test coverage
outside accessibility behavior, domain layering, auth threats, or telemetry.
