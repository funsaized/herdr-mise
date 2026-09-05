# Agent worker isolation decision

Status: target architecture selected; deployment and acceptance **NOT RUN**.
Applies to engineering backlog ENG-007, not the localhost application's runtime.

## Decision

Run untrusted autonomous review and build invocations on disposable Linux VMs,
one invocation per VM, with mandatory `bwrap` inside the worker. Destroy the VM
after success, failure, cancellation, or timeout. Do not reuse a maintainer's
macOS/Linux host as the production isolation boundary. Native macOS release
signing remains a separate trusted activity, outside agent workers.

The VM is the outer isolation boundary; `bwrap` narrows the agent's filesystem
access inside it. A container alone shares its host kernel. Disposable workers
also prevent one invocation's filesystem changes from persisting into another.
GitHub similarly warns that self-hosted runners lack the clean ephemeral VM
guarantees of hosted runners; see its
[secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).
This decision does not authorize infrastructure spending or deployment.

## Required worker contract

- Reviewers receive a read-only source snapshot, including immutable revision
  identity, plus separate writable scratch and output directories. A readonly
  CLI tool profile is an additional restriction, not the filesystem boundary.
- Builders receive a disposable writable checkout. Expose neither the original
  checkout nor its Git metadata through linked-worktree paths. If the existing
  integration requires linked-worktree metadata, keep the entire backing
  repository inside that same disposable VM.
- Never mount a host home directory, agent socket, Docker socket, cloud metadata
  credentials, signing keys, release credentials, or repository write tokens.
- Use provider-specific, short-lived authentication where supported. Prefer a
  reviewed gateway that holds the upstream credential outside the worker. If a
  provider cannot support the required boundary, that route is not eligible;
  do not silently fall back to personal login files.
- Enforce default-deny egress outside the agent's control, including DNS,
  private networks, and cloud metadata endpoints. Permit only the reviewed
  provider gateway. An allowed provider connection remains a data-disclosure
  channel: never put unrelated confidential data in the worker.
- Prepare pinned dependencies in a separate trusted image-building stage.
  Invocations must not expand their network policy to install missing tools.
  Treat exported patches, logs, and results as untrusted; apply bounded parsing
  and existing review/managed verification before accepting changes.
- Keep provisioning, image identity, network policy, credentials, and teardown
  outside the subject checkout. Proposed repository changes cannot grant their
  own permissions. Export only bounded, redacted evidence before teardown.

## Reuse the installed integration

Discovery with `swamp model type describe @funsaized/cli-agent --json` on
2026-09-05 identified version `2026.09.03.2` and its
`checkFactoryViability` method. Use this existing no-agent-launch probe on the
provisioned Linux worker before enabling an actor route; do not build a parallel
shell-based integration.

The probe requires `viabilityId`, `routeFingerprint`, `provider` (`amp` or
`opencode`), `model`, `cwd`, and `repositoryExpectation` containing an attached
branch, full head SHA, and state hash. Obtain identity using the integration's
documented contract; do not substitute a guessed state-hash algorithm. Bind
the probe evidence to the same route, subject, image, and policy as execution,
and invalidate it when any of those changes. Inspect generated Swamp reports
on probe failure before retrying.

The actor invocation's `factoryBoundary` also requires an actor tool profile,
caller invocation identity, repository expectation, and a required sandbox.
It is not a reviewer boundary. The ordinary invocation output does not itself
attest effective isolation. Retain the separate viability evidence and the
external canary results below.

Known integration limits:

- `sandboxMode: auto` with `sandboxRequired: true` prevents silent absence of
  an OS sandbox; it does not establish this worker contract.
- `sandboxNetwork: deny` is documented as Seatbelt-only. It must not be used
  as evidence of Linux egress enforcement.
- Linux `sandboxCredentialAccess: isolated` masks known login files but is
  not a substitute for an empty worker home and externally constrained auth.
- The built-in actor probe does not certify reviewer mounts, complete secret
  isolation, network policy, or VM teardown.

Current repository routes remain unchanged until this contract is demonstrated.
No live worker, remote agent, or paid provider invocation was started to test it.

## Deployment acceptance

Run positive and negative cases against the actual execution path, with dummy
credentials and a controlled denied endpoint. Record exact commit, image digest,
integration version, route/provider/model, effective backend, policy digest,
timestamps, exit status, and redacted observations. A configured flag, successful
launch, or self-reported agent assertion is not a passing negative test.

| Case                   | Required observation                                                                                       | Status  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ------- |
| Reviewer success       | Valid review output reaches the designated output directory.                                               | NOT RUN |
| Reviewer source writes | Direct writes, rename, deletion, and symlink traversal into source fail.                                   | NOT RUN |
| Builder success        | Intended source edits and representative tests succeed in its checkout.                                    | NOT RUN |
| Builder escape         | Writes outside checkout/scratch/output and to backing host metadata fail.                                  | NOT RUN |
| Credentials            | Unrelated fixture credentials and host sockets are inaccessible.                                           | NOT RUN |
| Egress                 | Provider request succeeds; controlled unauthorized DNS/HTTPS, private-network, and metadata requests fail. | NOT RUN |
| Fail closed            | Missing backend, stale identity, or unavailable policy enforcement prevents agent launch.                  | NOT RUN |
| Lifecycle              | Success, error, cancellation, and timeout destroy the VM; the next worker cannot read a prior marker.      | NOT RUN |

Enable routes only after the maintainer reviews the real evidence. This is a
trust-boundary change: the existing owner-dispatched managed verification gate
still applies. Local macOS checks remain advisory and cannot close Linux worker
acceptance. ENG-007 stays open until deployment acceptance passes.
