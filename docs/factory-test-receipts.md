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
`npm test` retains both tiers and the client suite, preserving coverage for the
current trusted managed verification workflow.

Rust receipts and automatic structured selection from approved plans remain
separate work. Existing builder-transcript/reviewer-run proof is supported during
migration; no receipt is synthesized from old test prose.
