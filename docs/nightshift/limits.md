# Known limits and remaining acceptance

These are operational limits, not a completed-performance claim. Remaining factory
acceptance is tracked in [issue #245](https://github.com/funsaized/herdr-mise/issues/245).
The September 20 refactoring delivered receipts, review convergence, managed
shipping, test tiers, the project-local Mac runtime, and shared-agent lifecycle
cleanup through PRs #243, #244, and #246–#249. Historical plans and measurements
remain in Git history; current proof comes from retained records and executable
checks.

## Shared-server cancellation

On the pinned Swamp `20260904.044433.0-sha.ab26e35b`, a local
`swamp model cancel` against a server-owned method killed the disposable shared
server with `SIGKILL` and left one ordinary fixture child alive. Two isolated
probes reproduced this; all owned fixture processes were cleaned afterward. The
remote caller lost its WebSocket. No production server was stopped.
[Sanitized observations](evidence/runtime-cancellation.json) retain the tested
version, outcomes, and cleanup scope.

A local direct-method cancellation did deliver `context.signal` and left zero
fixture children. Separately, all six native executor probes pass when a caller
abort signal reaches the installed agent. Those successes do not close the
shared-server defect. The cancelled run produced no fresh method report; report
retrieval returned the earlier successful `inspect` report.

Do not use local cancellation against a production shared-server run on this
runtime. Stop selecting new work and let active work finish when possible.
Recovery of a hung shared server needs operator inspection of the server and its
owned descendants; no fully tested safe shared-server cancellation path is
claimed. Platform cancellation/restart acceptance remains blocked.

## Worker and runtime guarantees

- [Mac filesystem and executor checks](worker-isolation.md) pass; complete
  repository-toolchain, inherited-socket, and credential-broker acceptance remains.
- Ordinary POSIX descendants in the owned process group are cleaned. Descendants
  creating another group/session remain outside that guarantee.
- Complete home isolation, exclusive scratch, and provider-only network egress
  are not implemented.
- The newer global CLI's template-provenance rejection remains upstream; use the
  tested project pin, never remove expression-provenance checks to bypass it.
- Status/advance parity and atomic intake/crash recovery need upstream work.
  The [upstream patch and handoff](../upstream/README.md) are partial proposals,
  not installed fixes. Keep intake single-writer.
- Remote multi-host workers and dependency/epic scheduling are not configured.

## Performance acceptance

No measured throughput, provider-cost, or escaped-defect improvement is claimed.
The retained September 20 fleet baseline covered 34 items and 872 closed stage
visits; 642 visits had agent timing. These coverage counts do not establish human
wait, true provider spend, or a defect-escape rate.

Before changing models, skipping review lanes, reusing review output, or raising
concurrency, complete independent replay of historical/seeded defects, controlled
cold/warm verification measurements, and at least ten comparable completed pilot
items. Track delivered throughput, tokens, useful-feedback time, rework,
infrastructure retries, human interventions, contention, seeded-defect detection,
and escaped severity together. Ten items are an operational checkpoint, not
statistical proof. Stop or revert if a material blocker would be missed or source
identity cannot be established.

All seven lanes remain active. Shadow routing never authorizes reuse. Historical
snapshots without structured test selections retain their original proof path;
no receipts or human approvals are synthesized from prose.
