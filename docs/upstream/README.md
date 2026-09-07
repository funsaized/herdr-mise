# Upstream factory follow-up

The included patch is against `swamp-club/swamp-extensions` commit
`9d273d8` (software-factory 2026.06.24.1). It shares the dispatch prerequisite
between status, the advance preflight check and advance execution, and tests
that human-approved global abort remains available without dispatch.

Apply in that repository:

```sh
git apply --unidiff-zero /path/to/software-factory-status-dispatch.patch
cd software-factory
deno test --allow-read --allow-write --allow-env extensions/models/ extensions/reports/
```

Verified using bundled Deno 2.9.6: new regression failed before the fix (status
said satisfied without dispatch); complete upstream suite passed 165/165 after
updating happy-path fixture setup to record dispatch. No assertions were removed.

This patch is a partial SF-003 contribution, **not an installed fix**. Status still
needs an upstream/platform seam for local advance checks such as workflow-run
correlation. Swamp rejects extension methods that collide with existing names;
replacing `status` in this repository cannot safely provide that seam.

SF-007 also needs platform work: the matching Swamp source
`src/libswamp/models/direct_execution.ts` already locks same-name creation, but
updates an existing definition's global arguments before invoking its method.
An opt-in create-if-absent policy must preserve existing direct-execution update
semantics and the explicit repair path. Multi-record crash recovery requires
fault injection across state/journal/approval writes, not a retry around start.
The checked-in isolated integration test reproduces the overwrite-before-rejection
behavior and asserts that duplicate start does not reset state.

Delivery blocker confirmed 2026-09-07: `git push --dry-run` to the upstream
repository returned HTTP 403, `Permission ... denied to funsaized`. Maintainers
must review/merge and publish upstream changes before this repository can pin
them. Installed generated source and checksums were not edited; no upstream
completion or atomicity guarantee is claimed.
