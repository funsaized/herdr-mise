# Parallel Nightshift Intake Plan

## Goal

Allow an orchestrator to intake new Nightshift work while another factory work
item is running, without adding remote workers or an external datastore.

The first use will intake these prepared features:

1. Responsive browser and TUI layout without obtrusive fill or hover expansion.
2. Truthful TUI station inspection.
3. Optional kitchen atmosphere treatments.

Each issue must be created idempotently, started in `the-nightshift`, added to
GitHub Project 2, and left at `planning` until explicitly driven.

## Decision

Use one long-running `swamp serve` process as the sole orchestrator for this
checkout. All callers submit workflows through that server. Keep the healthy
filesystem datastore at `.swamp/` and the existing per-work-item Git worktrees.

Permit only the metadata-only intake path to overlap an active factory run:

- `nightshift-create-intake`
- `nightshift-intake`
- `nightshift-project-sync`

Continue to run checkout-, build-, test-, review-, ship-, and verification-
mutating workflows under the existing exclusivity rule.

## Why This Is Safe

The intake path does not edit source files or produce build outputs:

1. `nightshift-github.create_issue` creates or finds one GitHub issue using its
   idempotency marker.
2. `nightshift-issues.start` records issue lifecycle state.
3. `the-nightshift.start` creates work-item state namespaced by issue number.
4. `nightshift-project-sync` refreshes all factory stages and reconciles the
   complete Project 2 view in one call.

Swamp model locks serialize brief calls to the same model. Factory artifacts
and state are already namespaced by work item. Project synchronization is a
full, idempotent reconciliation rather than an incremental local mutation.

The source checkout remains the hard boundary: no two workflows may
concurrently read or mutate shared checkout/build state unless they already use
isolated work-item worktrees and have explicit evidence that overlap is safe.

## Implementation

### 1. Establish The Orchestrator Boundary

- Run one `swamp serve` instance against the control checkout.
- Submit every workflow with `--server`; do not start independent local
  `swamp workflow run` processes while the server owns orchestration.
- Bind the server to loopback and use token authentication.
- Keep workflow definitions and model configuration in the control checkout.

### 2. Replace The Blanket Overlap Rule

Update `AGENTS.md` and `SWAMP.md` to state:

> Metadata-only intake workflows may overlap an orchestrated factory run.
> Workflows that use shared checkout files, build outputs, or runtime processes
> remain mutually exclusive in one checkout.

Name the three allowed workflows explicitly. Do not introduce a broad
"read-only workflows are safe" exception; the allowlist is the safety control.

### 3. Enforce The Classification

Extend the workflow contract test to traverse the allowed intake workflows and
fail if they acquire a source-mutating dependency. Allowed operations are:

- GitHub issue creation and Project 2 reconciliation.
- GitHub issue-lifecycle model methods.
- Software-factory state methods.
- Assertions and nested workflows on the same allowlist.

Reject CLI-agent invocation, Git workspace preparation, project builds, shell
execution, release operations, and verification subjects from this path.

### 4. Make Intake Retryable

- Preserve the caller-provided `idempotencyKey` through every attempt.
- If a model lock times out, let the orchestrator retry the complete intake
  workflow with bounded backoff.
- Rely on the existing issue marker and workflow guards so retries return the
  same issue and do not reset an existing factory run.
- Re-run full Project 2 reconciliation after any interrupted intake.
- Inspect `@swamp/workflow-summary` or `@swamp/method-summary` before retrying a
  failed run.

### 5. Pilot The Three Features

Submit the three prepared feature intakes through `swamp serve`, sequentially
within the intake lane, while an unrelated Nightshift build is active. Intake
requests may overlap the build, but intakes should remain FIFO to avoid
unnecessary contention on `the-nightshift` and `nightshift-github`.

Stop after each work item reaches `planning`. Do not run `nightshift-plan`
without a separate instruction.

## Verification

Automated checks:

- The workflow contract test proves every allowlisted workflow remains
  metadata-only.
- All changed workflows and models validate with Swamp.
- Repeating an idempotency key returns the same GitHub issue and factory work
  item.
- Project reconciliation reports no failed items.

Live concurrency check:

1. Start an isolated Nightshift build through `swamp serve`.
2. While it is active, submit one `nightshift-create-intake` run through the
   same server.
3. Confirm the build remains active and its stage and worktree are unchanged.
4. Confirm the new issue exists once, its work item is at `planning`, and its
   Project 2 status is `planning`.
5. Confirm `git status --short` in the control checkout contains no changes
   caused by intake.
6. Repeat the same intake key and confirm no duplicate issue or factory reset.

## Rollout

1. Land the allowlist, contract test, and documentation.
2. Start the single local orchestrator.
3. Pilot one feature intake during an active build.
4. Intake the remaining two features after the first result is verified.
5. Keep all other workflow overlap prohibited until separately reviewed.

If the pilot exposes lock contention or checkout mutation, restore exclusive
execution and keep incoming requests queued. Idempotent intake keys make that
rollback safe.

## Not Now

- Remote execution workers or worker affinity.
- An external S3, GCS, or shared-filesystem datastore.
- Multiple `swamp serve` replicas or multi-host orchestration.
- Parallel source mutation in the same worktree.
- General-purpose workflow concurrency classification.
- A new queue model; the orchestrator's intake lane is sufficient.

Reconsider an external datastore only when a second orchestrator host, high
availability, off-machine recovery, or shared team state becomes necessary.
