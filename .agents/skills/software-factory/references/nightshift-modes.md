# Nightshift driver modes

Nightshift autonomy is a resident-driver policy over the discovered factory
fleet. Each factory remains the delivery state machine for its work item;
existing workflows remain its execution units.

## Work-item identity

Accept only decimal GitHub issue numbers matching `^[1-9][0-9]*$`. Reject malformed
identities such as `#106` before calling a factory method or workflow.

## Factory instances

Each work item runs on its own factory instance, one model lock per item:

- `nightshift-run-<N>` — the runtime factory for work item `<N>` only; it must
  never read or write another work item.
- `the-nightshift` — the retained legacy shared factory; only active work item
  77 finishes here.
- `nightshift-template` — the canonical lifecycle template; it never runs work
  and owns no runtime records.

Fan-out is the one place that resolves an item's factory. It maps each work item
once to `{workItem, factory}` and passes that explicit `factory` to the child
workflow and to failure recording:

```text
w == "77" ? "the-nightshift" : "nightshift-run-" + w
```

Item 77 stays routed to `the-nightshift` until it is terminal; every other item
routes to its own runtime instance. Child workflows never derive the factory
independently.

## Fleet census

Discover every run with one query across the latest `state-*` records of every
`@swamp/software-factory` instance:

```bash
swamp data query 'modelType == "@swamp/software-factory" && name.startsWith("state-")' \
  --select '{"modelName": modelName, "modelId": modelId, "workItem": attributes.workItem, "stageId": attributes.stageId, "status": attributes.status}' --json
```

This returns the active legacy record on `the-nightshift` and every runtime
record on `^nightshift-run-[1-9][0-9]*$`. Before trusting any row, validate the
`(modelName, modelId, workItem)` tuple: `nightshift-run-N` may own only
`workItem=N`, and a work item must have exactly one owner. A duplicate or
mismatched owner is a hard stop — never choose an owner heuristically.

`state-*` is a census, not a schedule. It shows which items exist and their
coarse `stageId`/`status`; it never carries gates, transitions, or pending
approvals. Exclude terminal records from active dispatch and retain their
history. Never use `status-_factory` (or any factory-wide overview) as the
multi-instance scheduler source.

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

1. Take the fleet census (one `swamp data query` over the latest `state-*`
   records), validate each `(modelName, modelId, workItem)` tuple, and drop
   terminal and malformed rows.
2. Before dispatching any item, refresh that item's own status —
   `swamp model method run <factory> status --input workItem=<N>` — and classify
   it fresh from that packet.
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

Classify each item from its fresh status packet, never from the census
`stageId` or `status-_factory`:

- `actionable` — executable stage work or exactly one automatic transition.
- `gates` — a transition whose non-human gates are still unsatisfied; follow
  their reasons.
- `human-approval` — blocked only by a human gate; present it and wait.
- `rework` — a satisfied rework transition back to planning or building.
- `parked` — at the explicit `parked` stage awaiting a human exit.
- `terminal` — `done` or `aborted`; excluded from dispatch, retained as history.
- `malformed` — noncanonical work-item identity; report only, never dispatch.

Prepared features may enter through `nightshift-create-intake`, and open GitHub
issues without a matching factory state may enter through `nightshift-intake`.
Intake stays idempotent and never calls `start` for an existing run.

## Human boundary

Never call `approve` or `reset` without explicit human instruction. Autonomous
mode never grants `plan-approval`, `ship-approval`, `merge-confirmation`,
`rework-parked`, `rework-parked-build`, `abort-confirmation`, or a
`cycle-override:*` approval. A parked item returns through `rework-plan` or
`rework-build`, never through a cycle override.

Do not add parked to ship-prep. Do not edit factory `maxCycles` to unpark a
run.

Ship preparation follows `agent-constraints/ship-prep.md`. The driver may open
and record the candidate pull request, then leaves the item at `ship-approval`.
If the human requests changes, record `ship-feedback` verbatim and take the
manual `request-rework` transition; the item returns through building and code
review before ship prep.

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
