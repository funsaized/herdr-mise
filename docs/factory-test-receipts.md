# Factory test receipts

`@funsaized/npm/project.test_subject` runs an existing allowlisted npm test
script. It accepts the same subject/head/script/args as `run_subject`, plus
`reporter`: `node-tap`, `vitest-json`, or `playwright-json`. It appends the matching
reporter flag; the script must forward arguments to that runner. Use a narrowly
selected test script, not the mixed-runner `npm test` umbrella.

Run through the same authenticated Swamp server as the factory so receipts are
stored in the orchestrator's model data. Inspect the method schema with
`swamp model type describe @funsaized/npm/project --json` first.

The returned `test-receipt-*` resource includes actual argv, test counts, exit
status, Node/npm versions, source digests before and after, timestamps, invocation
and log pointers. Git tracked and untracked non-ignored files, executable bits,
symlink targets, and deletions contribute to the digest. Ignored dependencies and
generated outputs are excluded; this is source identity, not a whole-machine
attestation. A run that changes source, selects no passing tests, reports failed
or flaky tests, truncates its output, or lacks a valid reporter summary fails.

Before accepting a receipt, use `verify_test_receipt` on the same model with its
recorded name and current subject/head. It reads the stored record and recomputes
source identity; a caller-supplied JSON claim is not accepted. Reviewers still
decide whether the tests exercise the requested behavior. These receipts do not
replace trusted managed CI or prove that candidate test code is honest.

`npm run test:unit` runs Node unit/contract tests without provisioning a temporary
Swamp server. `npm run test:factory` runs the actual Swamp integration tier.
`npm run test:release` runs packaging and license-generation integration cases,
which may fetch locked Rust dependencies. `npm test` retains all three tiers and
the client suite, preserving managed verification coverage. The unit tier no
longer runs those dependency-fetching packaging cases.

Browser acceptance is split into visual matrix, interaction, and production
fixture suites, with shared helpers. Cross-browser critical accessibility stays
in its existing suite. Discovery before and after the split is identical: 121
project/test-title pairs. A subsequent TUI scenario split retains all assertions
and adds one separately scheduled case (122 total). Use `npm run test:visual` to prepare production assets;
`test:visual:prepared` assumes the managed build step has already refreshed them.
Stale production assets can make every fixture-backed test fail while visual
mode tests still pass.

`@funsaized/herdr-mise-rust.test_subject` runs one exact named test with
`target: lib` or `target: integration` plus `targetName`. It fixes the package to
`herdr-mise-server`, uses `--locked` and `--exact`, and rejects zero, ignored-only,
failed or source-mutating executions. The stored receipt includes Cargo/rustc
versions, argv, source digests, counts, invocation and bounded log pointers.
`verify_test_receipt` uses the same persisted-source check as npm. The Rust path
accepts uncommitted source so a builder can prove its proposed changes before
commit; matching HEAD alone is insufficient.

Both runners share bounded streaming, cancellation and output-truncation handling.
These methods execute candidate tests under the caller's existing execution
boundary; they do not provision an OS sandbox or establish credential isolation.

New `nightshift-template` plans require one to ten `testSelection` entries.
Each names `runner` (`node`, `vitest`, `playwright`, or `rust`) and a literal
`selector`. Rust also requires `target` and, for integration tests, `targetName`.
Node selects an exact title in `test:unit`; Vitest selects a client test title;
Playwright selects a title suffix across configured projects. Rust uses an exact
fully qualified test name. Arbitrary commands and runner flags are not accepted.

After implementation, `nightshift-run-tests` reads the persisted plan, its review
and the current-cycle human approval. It runs selections serially in per-build
model instances, verifies stored receipts, and records factory evidence. It
rejects changed approvals, mismatched argv, old-build receipts, changed HEAD or
source, missing results and zero passing tests. Review revalidates each receipt
against the current subject before launching the seven lanes.

Existing plans without selections retain builder-transcript/reviewer-run proof;
no receipt is synthesized from old test prose. Existing factory snapshots are
not rewritten. The new template schema applies to newly created instances.
