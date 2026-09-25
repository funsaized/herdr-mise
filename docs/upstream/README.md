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

## Current delivery and recovery blockers

Rechecked on 2026-09-21 against `swamp-club/swamp-extensions`
`536b04dafbba38df651c7fbb8f1694666f2a01ad`: the dispatch patch applies;
the baseline suite passes 164 tests and the patched suite passes 165. Both
`swamp-club/swamp-extensions` and `swamp-club/swamp` reject this account's
push dry runs with HTTP 403. No upstream release or local installed source was
changed. Maintainer review/publication is required for adoption.

The additional [crash reproduction](software-factory-crash-reproduction.patch)
applies after the dispatch patch. Its two assertions intentionally fail on the
current factory: failure while writing the `started` journal leaves visible state,
and failure while writing the `advanced` journal leaves the new stage visible.
Run only those cases with:

```sh
deno test --allow-read --allow-write --allow-env --filter 'atomicity:' \
  extensions/models/software_factory_test.ts
```

These are fault-injection reproductions, not a recovery fix. A correct solution
needs an atomic commit or a durable operation journal with idempotent recovery
across state, history, and approval writes. Merely reversing write order or
retrying `start` moves the partial-write problem; it does not solve it.

Current runtime `bcaa9695b7f27f51964a9f41587fdf112b261c89` still updates an
existing definition's global arguments before method execution in
`src/libswamp/models/direct_execution.ts`. The repository's real isolated
factory integration reproduces overwrite before duplicate-start rejection.
An opt-in create-if-absent mode must reuse the original definition, including
under concurrent creation, while preserving the default update and explicit
repair behavior. Until platform fixes are published and adopted, intake remains
single-writer and ambiguous interrupted writes need operator inspection.

## Owner-maintained fallback (authorized 2026-09-24)

The maintainer authorized forking or maintaining our own copies to resolve these
blockers. A GitHub mirror fork of the extensions now exists at
[`funsaized/swamp-extensions`](https://github.com/funsaized/swamp-extensions);
it is **not** a published or installed fix. The repository identifies a
Forgejo origin; a GitHub mirror fork alone cannot deliver an upstream release.
Do not edit generated `.swamp/pulled-extensions` files or
replace pinned checksums with an unreviewed build.

The [dispatch-parity branch](https://github.com/funsaized/swamp-extensions/tree/fix/factory-status-dispatch-245)
applies the existing patch to extension commit `76ac0cc59`; 167 model and
report tests passed locally. The branch must be rebased and retested against
the advancing upstream before release. It fixes only the dispatch prerequisite;
it does not evaluate repository-local advance checks from `status` or repair
interrupted writes.
[`funsaized/swamp`](https://github.com/funsaized/swamp) is a source fork, not a
released runtime. Neither fork is installed in this project.

If upstream cannot publish a fix, maintain a versioned extension from the fork:
apply and test the dispatch patch against the current upstream head, implement
the missing status/local-check parity and state/journal/approval recovery with
fault injection, publish under an owner-controlled registry identity, then pin
that identity and its checksums in `extensions/models/upstream_extensions.json`.
The runtime is a **separate** fork/release decision: first prove opt-in
create-if-absent and safe shared-server cancellation on a disposable server
with unrelated work and owned descendants. Only then update both
`verification/swamp-local-runtime.json` and `.swamp.yaml` to a verified release,
and rerun isolated factory tests plus maintainer-dispatched managed verification.
Keep the single-writer and no-local-cancel restrictions until those exact
artifacts are installed and acceptance passes. A fork is not evidence of a fix.
