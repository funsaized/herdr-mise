# Product verification

Use focused checks while developing, then push a branch and open a ready pull
request. Every push verifies the exact current head with native GitHub Actions.

## Local commands

```sh
npm ci
npm ci --prefix client
npm run doctor
npm run check                 # formatting, TypeScript, lint
npm test                      # Node, release contracts, client tests
npm run audit                 # compatibility, tokens, accessibility
npm run verify:rust           # Rust formatting, clippy, tests
npm run verify:browser:install # browser dependencies (once per host)
npm run verify                # complete product suite, including package smoke
```

`verify` tests the fallback assets using an explicit absent asset directory before
building the production client, then tests the embedded production assets.
It never deletes an existing client build to force fallback mode. Run one build
or verification at a time per checkout. Browser tests use checkout-specific ports.

Media work is separate: `npm run test:media` checks storyboards and capture
provenance; `npm run media -- check all` validates packaged TUI/product media with
ffmpeg. See [Media maintenance](product-demo.md). Capture dependencies are not
required for ordinary contributions.

## CI and merge policy

Product verification has three isolated jobs: source checks/tests/audits, Rust
fallback and production tests, and browser/package verification. The executor
checks out the exact PR head, verifies its ancestry against the PR base, and has
no token permissions or secrets. Each job gets its own checkout and build output.

A separate gate runs from `main`, reads GitHub metadata without executing PR
code, and verifies workflow identity and the current open PR head. Changes to
`verification/managed-policy.json` paths require an owner-authored PR from this
repository. The gate sets an exact-head status only after verification completes;
drafts and superseded runs do not receive a passing status.

During the two-step cutover the required status retains its legacy name,
`Swamp managed verification`, although execution uses only Node/npm and Rust.
The follow-up rename switches it to `Product verification` after a successful
new status is available; other required checks remain enforced throughout.

Local results are advisory. Branch protection requires the trusted current-head
status and an up-to-date branch. Security/advisory scans and trusted release
builds remain separate. PR artifacts are never promoted to release artifacts.

Inspect Actions logs and retained `browser-failures` traces/screenshots when a
run fails. Fix source failures in a new commit; rerun infrastructure failures
only after inspecting the failure. Agent prose is not evidence of test execution.
