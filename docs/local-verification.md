# Local verification and the remote CI gate

The `local-verification` swamp workflow runs deterministic build and test
controls before a pull request opens. It publishes the exact run outputs to the
append-only `ops/evidence` branch. GitHub CI validates that evidence in seconds
instead of re-running the controls to discover failures.

## Run before opening or updating a pull request

Use narrow checks during parallel development. When the branch is next to merge,
sync it with current `origin/main`, commit the final tree, then run:

```sh
swamp workflow validate local-verification
swamp workflow run local-verification --input commit=$(git rev-parse HEAD)
```

The workflow fetches from `origin`, looks up current remote `main`, then fails before
dependency installation unless that commit is an ancestor of the supplied
commit. It does not merge or rebase the source branch. It also requires a clean
worktree and binds every npm and Rust invocation to the supplied commit. It
installs locked dependencies, installs Playwright Chromium, checks fallback and
production Rust assets, and runs formatting, build, type, lint, unit,
compatibility, browser, audit, bundle, and release controls. The final steps
collect and publish evidence without changing the source branch.

Only the branch next to merge should run the full workflow. Other parallel
branches should continue using narrow checks until they reach that point. If
`main` advances before merge, sync again and produce evidence for the resulting
new commit.

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
- current-run fetch, remote-main lookup, and matching ancestry result;
- workflow identity, required step order, and 24-hour freshness;
- verification configuration checksums;
- exact model, method, output set, status, and clean Git state for every step;
- SHA-256 and size of every embedded swamp output;
- Rust and npm structured success results;
- artifact manifest completeness and the canonical evidence root.

CI fails closed when evidence is absent, stale, duplicated, malformed, or does
not match the checked-out source commit.

The evidence job runs for pull requests and non-`main` branch pushes. It skips
post-merge pushes to `main` because GitHub creates a new merge commit only after
the pull request gate passes, so exact-commit evidence cannot exist for that SHA
before merge. The shadow and security jobs still run against the resulting
`main` commit.

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
