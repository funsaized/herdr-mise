# Nightshift driver modes

Nightshift autonomy is a resident-driver policy over `the-nightshift`. The
factory remains the only delivery state machine; existing workflows remain its
execution units.

## Work-item identity

Accept only decimal GitHub issue numbers matching `^[0-9]+$`. Reject malformed
identities such as `#106` before calling a factory method or workflow.

## Modes

| Mode                 | Mechanism                              | Stop condition                    |
| -------------------- | -------------------------------------- | --------------------------------- |
| Single-feature drive | Drive one factory run                  | Human gate                        |
| Planning queue       | Serial `nightshift-plan-fanout`        | Plan approval                     |
| Review swarm         | `nightshift-review` with seven lanes   | Findings recorded                 |
| Build fan-out        | `nightshift-build-fanout`, maximum two | Code review                       |
| Plan-only            | Drive through plan review              | Plan approval                     |
| Closeout             | Ship, deployed verification, and close | Merge confirmation                |
| Recovery             | Resume with `status`, never `start`    | Ambiguous failure classification  |
| Rework-parked        | Human-approved exit from `parked`      | Approval decision                 |
| Autonomous           | Select across all modes                | Explicit stop or idle human queue |

## Autonomous loop

1. Run factory-wide `status`, then refresh the selected work item's `status`
   before acting.
2. Classify every run as `actionable`, `human-wait`, `parked`, `terminal`, or
   `malformed`.
3. Retry configuration or infrastructure failures.
4. Run pending plan or code reviews.
5. Build ready independent work through `nightshift-build-fanout`, at most two.
6. Plan queued work through `nightshift-plan-fanout`, one at a time.
7. Perform interactive ship preparation.
8. Skip human-wait and parked work while any actionable work remains.
9. Before every work-bearing stage, call `record_dispatch` for its work item,
   including every item passed to a fan-out.
10. Execute the resolved workflow, method, dispatch, or interactive work spec
    and record all artifacts and evidence through the factory.
11. Refresh status and take at most one unambiguous, non-manual transition with
    no human gate.
12. Repeat until stopped or no work is actionable.

An actionable run has executable stage work or exactly one automatic
transition. A human-wait run is blocked by a manual transition or human gate.
A parked run is at the explicit `parked` stage. A terminal run is done or
aborted. A malformed run has a noncanonical work-item identity and must only be
reported.

Prepared features may enter through `nightshift-create-intake`, and open GitHub
issues without a matching factory state may enter through `nightshift-intake`.
Intake stays idempotent and never calls `start` for an existing run.

## Human boundary

Never call `approve` or `reset` without explicit human instruction. Autonomous
mode never grants `plan-approval`, `ship-approval`, `merge-confirmation`,
`rework-parked`, `rework-parked-build`, `abort-confirmation`, or a
`cycle-override:*` approval. A parked item returns through `rework-plan` or
`rework-build`, never through a cycle override.

Ship preparation follows `agent-constraints/ship-prep.md`. The driver may open
and record the candidate pull request, then leaves the item at `ship-approval`.

## Checkout exclusions

Use one authenticated `swamp serve` process per checkout. Metadata-only
`nightshift-create-intake` and `nightshift-intake` may overlap factory work.
Planning, building, reviewing, shipping, and verification are otherwise
mutually exclusive in one checkout. Internal fan-out is limited to one planner,
two builders, or the existing seven review lanes. Do not overlap plan and build
fan-outs.

## Idle and stop

When no run is actionable, use each status record's context manifest to fetch
the latest subject and own artifacts for pending human gates. Report that human
queue together with parked and malformed items, then idle without polling.
Refresh when work changes or the human instructs the driver; stop selecting new
work immediately when told to stop.

Interactive resident-driver tokens and cost are unavailable, not zero. Do not
add metering unless an existing CLI-agent can preserve safe idle and stop
behavior.
