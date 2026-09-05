# Managed verification migration record

The migration from developer-published schema-v1 evidence to
maintainer-authorized managed Swamp verification is complete. The live
operational references are [`SWAMP.md`](../SWAMP.md) and
[`local-verification.md`](local-verification.md).

## Outcome

- One shared `verification` Swamp workflow owns deterministic source checks.
- A maintainer dispatches `Swamp managed verification` from trusted `main` with
  an open pull request number.
- The resolver records immutable PR, workflow, actor, source, base, and control
  identity and requires owner dispatch for trust-boundary changes.
- The subject executor has no repository permissions, secrets, cloud identity,
  release identity, or environment.
- The trusted gate validates the managed conclusion, current PR state, exact
  SHAs, and schema-v2 audit record before setting the required status.
- Security, dependency, release, signing, publication, and public acceptance
  remain independent remote controls.
- The retired `ops/evidence` branch remains protected and readable as historical
  evidence, but no active workflow reads or writes it.

## Canary evidence

The managed path was exercised before retirement:

| Case                          | Executor      | Gate          | Result                             |
| ----------------------------- | ------------- | ------------- | ---------------------------------- |
| Same-repository PR            | `33201728394` | `33202296544` | Passed                             |
| Fork PR                       | `33202788434` | `33203318832` | Passed                             |
| Owner-dispatched trust change | `33203709187` | `33204279930` | Passed with `trustBoundary: true`  |
| Moved head                    | `33204355814` | `33204879260` | Old SHA failed closed              |
| Replacement head              | `33204928273` | `33205501695` | Passed                             |
| Non-writer dispatch           | N/A           | N/A           | GitHub denied dispatch             |
| Temporary writer trust change | `33207823776` | N/A           | Resolver rejected before execution |

The managed verifier also received fixes for Playwright browser persistence and
ANSI-free Swamp version capture before cutover.

## Cutover

The order was:

1. Deploy the managed executor and trusted gate.
2. Run same-repository, fork, moved-head, and authorization canaries.
3. Add `Swamp managed verification` to required `main` statuses.
4. Remove the legacy evidence and shadow contexts from branch protection.
5. Retire the legacy CI jobs, schema-v1 workflow, publisher model, policy,
   collector, validator, tests, and duplicated shadow command list.
6. Preserve managed schema v2, release controls, security controls, and
   historical evidence.

The owner explicitly authorized retirement before the plan's default
20-successful-run and three-fork-run observation threshold. That threshold was
an operational confidence gate rather than a correctness proof; this exception
is recorded so the shorter observation period is not mistaken for an omission.

## Current trust boundary

The path allowlist is authoritative in `verification/managed-policy.json` and
enforced by the trusted resolver. Proposed changes to workflows, models,
extensions and policies do not replace the trusted controller until merged.
The npm commands and tests themselves execute from the proposed source so new
behavior is exercised. Package scripts, lockfiles, test configurations, and
audit/test scripts are therefore classified as trust-boundary changes and
require dispatch by `@funsaized`. The allowlist names an invocation, not an
immutable implementation of that command. Separate checkout directories are
not an OS sandbox.

The verification DAG runs independent root/client dependency installs on
different model instances, then cheap checks before browser setup and Rust
compilation. Prepared browser/bundle scripts reuse the production client build.
Within a run, npm installs share an ephemeral download cache under the runner
temporary directory; npm still checks lockfile integrity. Nothing is restored
across runs, and no `node_modules`, compiled executables, or managed evidence is
cached.

The required Rust result now explicitly includes Clippy. Extension tests execute
the proposed `extensions/tests` with Swamp's Deno, type checking, no runtime
network permission, and only git subprocess permission. GitHub retains browser
failure traces/screenshots for seven days. This does not change the controller
provenance: these new controls become authoritative only after owner-reviewed
adoption on main and a fresh managed dispatch.

The managed execution signal is conventional hosted-CI assurance. The retained
attestation adds structured audit detail and tamper detection but is not an
independent source of execution truth.

## Rollback

If the managed gate still works, restore any retired control through a separate
owner-dispatched trust-boundary PR, observe its status on a real PR, add its
context to branch protection, and only then remove the managed requirement.

If the managed gate itself is broken, use the recorded branch-protection
snapshot as a settings-first break glass: remove only the broken managed
context, land the repair through remaining protections, observe the restored
context, and reapply the intended protection. Never require a context before
its workflow exists, and never rewrite historical `ops/evidence` records.
