# Nightshift Factory Use Cases

## Purpose

The Nightshift factory is a gated software-delivery state machine that tracks
many independent work items from planning through deployed verification and
closure. Operating modes determine which work items a driver selects, how much
concurrency it allows, and where it stops for human approval.

The factory stores state and enforces gates. It does not currently poll queued
work or propel work items without an active human or agent driver.

See `SWAMP.md` for operating commands.

## Current Capabilities

- Factory state, evidence, artifacts, and journals are namespaced by work item.
- Planning produces a persisted plan and a seven-lane plan review.
- Approved builds use per-work-item agent models and direct-sibling Git
  worktrees.
- `nightshift-build-fanout` can build at most two ready work items concurrently.
- Code review runs seven isolated specialist lanes concurrently.
- Candidate failures return to implementation; configuration and infrastructure
  failures retry the operational stage.
- Shipping verifies an exact commit, and deployed verification checks the exact
  merged pull-request revision.
- Terminal cleanup removes generated artifacts and clean worktrees while
  preserving dirty source for inspection.
- GitHub Project 2 is a projection of authoritative factory state.

## Concurrency Boundary

- Use one authenticated `swamp serve` process as the orchestrator for a
  checkout.
- Metadata-only `nightshift-create-intake`, `nightshift-intake`, and
  `nightshift-project-sync` runs may overlap an active factory run.
- Keep external planning, build, review, shipping, and verification workflow
  runs mutually exclusive in one checkout.
- Internal fan-out remains bounded: seven review lanes and at most two isolated
  builders.
- Intake is FIFO and idempotent so interrupted requests can be replayed without
  duplicating issues or resetting factory work.

## Available Operating Modes

| Mode                  | Use                                                                                   | Automation boundary                                                        |
| --------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Single-feature drive  | Move one issue through planning, implementation, review, and delivery                 | Stops at plan, ship, and merge approvals                                   |
| Planning queue        | Plan and review several queued issues before implementation                           | Planning is sequential because the planner has one shared model lock       |
| Parallel build batch  | Build approved, independent work items                                                | Requires an explicit `nightshift-build-fanout` run and allows two builders |
| Review swarm          | Review a plan or implementation through seven specialist lanes                        | Produces findings and a deterministic worst verdict                        |
| Plan-only advisory    | Produce a reviewed implementation plan without changing source                        | Stops at plan approval                                                     |
| Pull-request closeout | Resume merged work, verify the hosted result, clean the worktree, and close the issue | Requires explicit merge confirmation                                       |
| Recovery              | Resume failed or interrupted work from persisted factory state                        | Human input is required when failure classification is ambiguous           |
| Board reconciliation  | Repair GitHub Project 2 from current factory stages                                   | Metadata-only and safe to repeat                                           |
| Canary delivery       | Exercise the complete factory with one low-risk change                                | Useful after changing factory definitions or controls                      |

Stage workflows must be invoked through a factory driver. The driver records
dispatch, executes the resolved work specification, inspects gates, advances
unambiguous automatic transitions, and stops at human approvals.

## Proposed Nightly Mode

A useful unattended Nightshift session would:

1. Intake queued requests idempotently.
2. Plan unplanned items sequentially.
3. Run plan-review swarms.
4. Park new plans at human approval.
5. Build previously approved items, at most two at a time.
6. Run code-review swarms.
7. Return clear candidate failures to implementation.
8. Retry bounded configuration or infrastructure failures.
9. Park verified candidates at ship approval.
10. Produce a morning report of approvals, failures, and completed work.

Nightly mode must never grant plan, ship, merge, cycle-override, or abort
approvals on behalf of a human.

## Proposed Continuous-Flow Mode

A resident driver could poll factory status and enforce work-in-progress limits:

| Stage group                        | Suggested limit |
| ---------------------------------- | --------------: |
| Planning                           |               1 |
| Building                           |               2 |
| Shipping and deployed verification |               1 |
| Parked at human gates              |       Unlimited |

When capacity becomes available, the driver would select the next eligible work
item by an explicit priority policy. It would automatically execute only stages
and transitions without pending human gates.

This driver does not exist yet. `swamp serve` hosts and serializes requests but
does not itself poll or propel factory work.

## Other Uses

- Batch small maintenance and dependency fixes.
- Pre-plan a backlog before a milestone.
- Run architecture, accessibility, security, observability, and test reviews
  without implementation.
- Resume partially completed work after an agent or infrastructure failure.
- Maintain an auditable issue-to-plan-to-commit-to-merge history.
- Use the factory as the source of truth while Project 2 remains the operator
  view.

## Current Limits

- Queued planning items are not picked up automatically.
- Planning cannot run concurrently through the shared `nightshift-planner`
  model.
- Planning and building are not approved to overlap in the same checkout.
- More than two concurrent builds are not supported.
- Shipping and verification workflows remain mutually exclusive in one
  checkout.
- Work-item dependencies and epic-level gates are not modeled.
- Merge and deployment approvals cannot be unattended.
- Remote multi-host execution is not configured.

## Next Addition

The highest-value addition is a resident Nightshift driver with explicit modes:

- `interactive`: drive one named item to its next human gate.
- `plan-only`: plan and review queued work without implementation.
- `nightly`: plan queued work and build only previously approved items.
- `build-ready`: collect eligible building items and invoke build fan-out.
- `closeout`: process merged items through deployed verification and closure.
- `recover`: inspect failed or parked items and present actionable choices.

The driver should reuse `the-nightshift` rather than introduce another state
machine.
