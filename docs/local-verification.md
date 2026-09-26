# Managed verification

Every non-draft pull request head is verified automatically by the
`Swamp managed verification` GitHub workflow. Local Swamp runs are optional
advisory feedback and cannot satisfy branch protection.

## Contributor flow

1. Use narrow checks while developing.
2. Commit a clean branch based on current canonical `main`.
3. Push the branch and open or update the pull request (mark it ready for
   review; drafts are skipped).
4. Wait for the `Swamp managed verification` status on the current head. Every
   push or rebase starts a new run and supersedes the previous one.

To run the same deterministic controls locally, configure `upstream` as the
canonical repository and run from a clean sibling worktree of the change:

```sh
swamp workflow validate verification
swamp workflow run verification \
  --input commit=$(git rev-parse HEAD) \
  --input baseCommit=$(git rev-parse upstream/main) \
  --input subjectRoot=../herdr-mise-subject
```

The local result is advisory and sets no GitHub status. Independent checks run
in parallel lanes, so a local run takes about five minutes.

## How the status is set

The executor runs on `pull_request` with no token permissions or secrets. It
checks out the pull request's base as the trusted controls and the exact head
as a separate subject, then runs the shared `verification` Swamp workflow.

A separate gate always runs its definition from `main` and never executes pull
request code. For the completed run it confirms the executor's identity, that
the run's head is still the head of an open pull request against `main`, and
whether the pull request touches any path in `verification/managed-policy.json`.
It then sets `Swamp managed verification` on that exact head:

- success when the run succeeded;
- failure when the run failed, or when a trust-boundary path changed and the
  pull request is not authored by the code owner from this repository (such a
  pull request could rewrite the executor itself);
- no status for skipped (draft) or cancelled (superseded) runs.

Branch protection requires the status and an up-to-date branch, so a moved
`main` means a rebase and a fresh run. Security, dependency, release, signing,
publication, and public-artifact checks remain separate remote controls.

## Trust-boundary changes from other contributors

The gate fails these by design. A maintainer reviews the change and pushes it
to a branch in this repository as their own pull request, which then verifies
normally.

## Failure handling

Inspect the managed workflow logs and the `swamp-managed-diagnostics` artifact
first. When Swamp itself fails, inspect its generated workflow summary before
changing definitions or retrying:

```sh
swamp report get @swamp/workflow-summary --workflow verification --json
```

Fix source failures in a new commit; infrastructure failures can be re-run from
the Actions page. The protected `ops/evidence` branch is retained as historical
schema-v1 evidence; no active workflow writes to or validates against it.
