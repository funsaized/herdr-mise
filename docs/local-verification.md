# Managed verification

Pull-request verification runs through a maintainer-dispatched GitHub workflow.
Local Swamp runs are optional advisory feedback and cannot satisfy branch
protection.

## Contributor flow

1. Use narrow checks while developing.
2. Commit a clean branch based on current canonical `main`.
3. Push the branch and open or update the pull request.
4. Ask a maintainer to dispatch managed verification for the current PR number.
5. Do not push another commit while expecting the old status to remain valid.

To run the same deterministic controls locally, configure `upstream` as the
canonical repository and run:

```sh
swamp workflow validate verification
swamp workflow run verification \
  --input commit=$(git rev-parse HEAD) \
  --input baseCommit=$(git rev-parse upstream/main) \
  --input subjectRoot=.
```

The local result is advisory. It writes a schema-v2 manifest under ignored
Swamp runtime state but does not publish evidence or set a GitHub status.

## Maintainer flow

1. Review the exact current pull-request head.
2. Open **Actions**, select **Swamp managed verification**, and choose **Run
   workflow** from `main`.
3. Enter the open pull request number as `prNumber`.
4. Wait for the `Swamp managed verification` status on the current head.
5. Investigate failures before rerunning. Dispatch again after any new commit or
   `main` movement.

The resolver classifies changes to workflows, models, extensions, policy, and
other configured trust-boundary paths. Only `@funsaized` may dispatch those
changes. The executor uses the trusted controls from `main`, checks out the
proposed source separately, and has no repository permissions or secrets.

## Gate behavior

The managed executor runs the shared `verification` Swamp workflow against the
exact PR SHA. It retains request metadata and the schema-v2 attestation as
GitHub Actions artifacts for 30 days.

A separate trusted gate checks the workflow identity, dispatcher, current PR
head and base, source and control SHAs, policy and workflow digests, step
results, timing, lockfiles, artifacts, freshness, and canonical evidence root.
It sets the required status only when all checks agree. A moved head, moved
base, failed run, local attestation, malformed record, or unauthorized
trust-boundary dispatch fails closed.

Security, dependency, release, signing, publication, and public-artifact checks
remain separate remote controls.

## Failure handling

Inspect the managed workflow logs first. When Swamp itself fails, inspect its
generated workflow summary before changing definitions or retrying:

```sh
swamp report get @swamp/workflow-summary --workflow verification --json
```

Fix source failures in a new commit and dispatch a new run. Do not try to reuse
the status or attestation from an older head.

The protected `ops/evidence` branch is retained as historical schema-v1 evidence.
No active workflow writes to or validates against it.
