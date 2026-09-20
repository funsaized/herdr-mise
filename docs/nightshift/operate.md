# How to operate the factory

Use the [configured runtime and shared server](setup.md). Commands below run from
the repository root. Discover current syntax with `npm run swamp:local -- help`
and method arguments with `model type describe`; persisted `status` is the
execution contract. Never substitute a remembered stage sequence for it.

## Intake an issue

For an existing approved GitHub issue, set `ITEM` to its decimal number (no `#`):

```sh
ITEM=123
npm run swamp:local -- workflow validate nightshift-intake
npm run swamp:local -- workflow run nightshift-intake \
  --input workItem="$ITEM" --input issueNumber="$ITEM"
```

For prepared new features, review the non-empty array in
[`intake/nightshift-features.json`](../../intake/nightshift-features.json), then:

```sh
npm run swamp:local -- workflow validate nightshift-create-intake
npm run with:swamp-local -- npm run intake:nightshift
```

Each entry has a stable `idempotencyKey`, `title`, optional `body`, and optional
`labels`. Reuse its key on retry. The client retries only model-lock timeouts with
bounded backoff and retrieves failure reports first. Intake must remain the
single creator of runtime definitions through the shared server; it is not
atomic create-if-absent across arbitrary writers.

## Drive one issue or stop after planning

1. Discover the item's unique owner using the [tutorial census](tutorial.md).
2. Refresh `status` for that factory and item. Read its resolved work and gates.
3. Before executing a work-bearing stage, call `record_dispatch` for that item.
4. Execute the specified workflow/method or interactive work. Validate a workflow
   before running it. Record the requested artifacts and result evidence through
   the factory; conversation alone is not durable state.
5. Refresh `status`. Advance only one unambiguous satisfied transition with no
   pending human gate and no `manual: true`. Otherwise follow the reported blocker.
6. At a human gate, fetch the recorded subject afresh and present it. Record an
   approval only after the human explicitly approves that subject.

A plan-only request ends at plan approval. A delivery request continues through
implementation, code review, ship preparation, managed verification, explicit
merge confirmation, deployed verification, and cleanup as its definition allows.
Use [the driver skill](../../.agents/skills/software-factory/SKILL.md) for the exact
recording and approval methods.

## Work a queue

Use `nightshift-plan-fanout` for queued plans and `nightshift-build-fanout` for
approved independent builds. Both accept `workItems`, an array of decimal issue
strings. Refresh each item's status and record its dispatch before including it.
The fan-out resolves the owner once and passes it to every child workflow.

Keep major phases mutually exclusive. Limits are one planner, two builders,
or seven review lanes—not ten simultaneous workers. Only metadata-only intake
may overlap, using the same server. Skip human-wait and parked items while other
work is actionable. When none remains, report the fresh human queue and idle
without polling. Stop selecting new work when asked to stop.

## Review or resolve disputed findings

Run the review work specification from current status; it supplies the phase,
subject, workspace, prior findings, and receipts. All seven lanes run. Read
findings under the [shared review contract](../../agent-constraints/review.md).
A disputed high/critical finding remains blocking. New instances park repeated
disputes after two distinct cycles for human adjudication; retrying the same cycle
does not count twice.

To resume parked work, obtain explicit approval for `rework-parked` or
`rework-parked-build` and take its matching exit. Do not raise `maxCycles`, reset
history, or use a cycle override as an unpark mechanism.

## Deliver a reviewed change

Follow [ship preparation](../../agent-constraints/ship-prep.md) and the
[maintainer verification procedure](../local-verification.md). Open a PR linked
with `Fixes #<issue>` and retain the exact subject commit. Every new commit or
base movement requires a fresh managed run. Trust-boundary changes require
`@funsaized` to dispatch from trusted `main`.

`nightshift-ship` consumes the validated `swamp-managed-receipt`; a green badge or
local full-suite pass is insufficient. Preserve ship approval, merge confirmation,
and deployed smoke. After merge, refresh factory status and finish its deployed
verification and closeout work. A closed GitHub issue does not prove those stages
completed. Cleanup preserves dirty workspaces for inspection.

## Recover an interrupted or failed run

Start with `status`, never `start` or `reset`. Inspect the report before retrying:

```sh
npm run swamp:local -- report get @swamp/workflow-summary --workflow nightshift-build --json
npm run swamp:local -- report get @swamp/method-summary --model "$FACTORY" --json
npm run swamp:local -- run history --active
npm run swamp:local -- run doctor
```

Use the actual failed workflow/model name. Check report method, timestamp, and run
identity: a killed process may leave only an older successful report. Candidate
failures return to implementation; diagnosed infrastructure/configuration failures
retry their operational stage. Ask for human input when classification is ambiguous.
Review a diagnosis before `run doctor --fix`.

Explicit snapshot restoration uses `nightshift-factory-repair` with `modelName`
and `confirm=repair`, after validation and human authorization to repair. It
preserves model identity and data. Do not use repair to silently migrate an active
item to a newer template. Avoid local cancellation of server-owned runs on the
[current runtime](limits.md#shared-server-cancellation).

## Report history and performance

Use the owning factory's `summary` method for one item. To generate retained-fleet
analytics without advancing delivery:

```sh
npm run swamp:local -- workflow validate nightshift-analytics
npm run swamp:local -- workflow run nightshift-analytics \
  --input factory="$FACTORY" --input workItem="$ITEM"
npm run swamp:local -- report get @funsaized/nightshift-fleet-analytics \
  --workflow nightshift-analytics --json
```

The item summary triggers a report across the retained fleet. Stage residence
includes execution and waiting; overlapping execution intervals count once.
Remaining time is unattributed, not a measured human wait. Missing costs/timings
are unavailable, not zero. See [measurement limits](limits.md#performance-acceptance).
