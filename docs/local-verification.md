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

Installer and public-artifact tests remove their own temporary fixtures on
success, failure, SIGINT and SIGTERM, stopping test-owned soak processes first.
To retain fixtures for debugging, use `HERDR_MISE_KEEP_TEST_TEMP=1` with
`node --test scripts/install.test.mjs scripts/public-artifact.test.mjs`; retained
paths are printed and processes are still stopped. Cleanup failures retain the
affected directory and fail the run. SIGKILL and host crashes cannot run cleanup;
inspect recorded ownership before removing leftovers or stopping a process.

The full suite includes local package smoke and a short server resource check.
It excludes `npm run perf`, `npm run perf:endurance`, `npm run measure:tui`,
hosted checks, media maintenance, public-download/signature verification and
manual assistive-technology testing. Chromium runs the browser suite; Firefox
and WebKit run `critical-accessibility.spec.ts`. Report skips and renderer
fallbacks separately. Fixture sockets and the playground do not prove a real
Herdr connection; a locally packaged archive does not prove a published release.

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
drafts and superseded runs do not receive a passing status. Success also requires
successful `checks`, `rust` and `browser-and-package` jobs from the latest run
attempt, so an all-skipped draft run cannot certify the same SHA after readiness.

The required exact-head status is `Product verification`. Its definition lives
in `.github/workflows/product-verification.yml`; the trusted gate lives in
`.github/workflows/product-verification-gate.yml`.

Local results are advisory. Branch protection requires the trusted current-head
status and an up-to-date branch. Security/advisory scans and trusted release
builds remain separate. PR artifacts are never promoted to release artifacts.

Inspect Actions logs and retained `browser-failures` traces/screenshots when a
run fails. Fix source failures in a new commit; rerun infrastructure failures
only after inspecting the failure. Agent prose is not evidence of test execution.
