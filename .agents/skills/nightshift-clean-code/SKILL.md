---
name: nightshift-clean-code
description: Review a Nightshift plan or change for scope, dead code, premature abstraction, and misplaced constants.
---

# Nightshift Clean Code

Review only whether the change is the smallest maintainable implementation of
the accepted issue.

## Inspect

- Flag scope beyond the GitHub issue and code that has no current caller.
- Prefer an existing shared path, standard library feature, or installed
  dependency over a new helper or abstraction.
- Flag one-implementation interfaces, speculative factories, compatibility
  shims without a shipped consumer, and configuration for values that do not
  vary.
- Keep visual constants in `client/src/theme/tokens.ts`, compatibility facts in
  `compatibility/herdr.json`, and protocol facts at the existing protocol or
  adapter boundary rather than scattering literals.
- Require comments to explain why, not restate what the code does.
- Prefer deletion and a root-cause fix over parallel guards in callers.

## Exclude

Do not judge visual composition, responsive behavior, aggregate boundaries,
test sufficiency, exploitability, accessibility conformance, or observability.
