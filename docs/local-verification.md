# Local verification and the remote CI gate

The `local-verification` swamp workflow runs deterministic build and test
controls before a pull request opens. It publishes the exact run outputs to the
append-only `ops/evidence` branch. GitHub CI validates that evidence in seconds
instead of re-running the controls to discover failures.

## Run before opening or updating a pull request

Commit the source first, then run:

```sh
swamp workflow validate local-verification
swamp workflow run local-verification --input commit=$(git rev-parse HEAD)
```

The workflow requires a clean worktree and binds every npm and Rust invocation
to the supplied commit. It installs locked dependencies, installs Playwright
Chromium, checks fallback and production Rust assets, and runs formatting,
build, type, lint, unit, compatibility, browser, audit, bundle, and release
controls. The final steps collect and publish evidence without changing the
source branch.

## Evidence branch

`ops/evidence` is an orphan branch containing only append-only verification
records:

```text
evidence/v1/<source-commit>/<workflow-run-id>/manifest.json
```

Each manifest contains:

- the source commit and Git tree SHA;
- the workflow identity and run ID;
- SHA-256 checksums of verification policy and configuration files;
- every required step's model, method, status, and exact swamp output bytes;
- hashes and sizes for each embedded swamp data record;
- file manifests for `client/dist` and the release binary;
- a canonical SHA-256 root over the complete evidence document.

Large binaries, dependency directories, and Cargo build directories are not
committed. Their file manifests are retained; trusted release infrastructure
still produces and verifies shipped artifacts.

The branch rejects force pushes and deletion. New workflow runs create new
directories rather than replacing prior evidence.

## What GitHub validates

The `Local verification evidence` job checks out the pull request head commit
and `ops/evidence`, then independently checks:

- source commit and Git tree identity;
- workflow identity, required step order, and 24-hour freshness;
- verification configuration checksums;
- exact model, method, output set, status, and clean Git state for every step;
- SHA-256 and size of every embedded swamp output;
- Rust and npm structured success results;
- artifact manifest completeness and the canonical evidence root.

CI fails closed when evidence is absent, stale, duplicated, malformed, or does
not match the checked-out source commit.

## Trust boundary and migration

The evidence is a claim made by the local verification environment. Git makes
the record durable and tamper-evident, while CI independently validates its
commit, configuration, completeness, and internal hashes. It does not prove an
untrusted machine honestly executed the commands.

Keep these controls on trusted remote infrastructure:

- CodeQL, dependency review, Gitleaks, and Rust advisory scanning;
- release matrix builds, Apple signing/notarization, publication, and public
  artifact acceptance tests;
- any future control requiring an ephemeral managed runner.

The old full verification job remains `Shadow full verification (blocking
migration)`. Record every shadow failure after a local pass as a CI escape.
Only remove duplicated remote execution after a useful sample has zero
unexplained escapes; restore it immediately if the escape rate rises.
