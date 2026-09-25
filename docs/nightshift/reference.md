# Nightshift reference

## Identity and ownership

| Object                | Contract                                                                |
| --------------------- | ----------------------------------------------------------------------- |
| `workItem`            | Decimal GitHub issue number matching `^[1-9][0-9]*$`; no `#` prefix     |
| `nightshift-template` | Canonical definition for new runs; never executes work                  |
| `nightshift-run-N`    | Owns only item `N`; independent model lock and stored history           |
| `the-nightshift`      | Retired legacy name; stored reports and historical fixture retained     |
| Factory artifact      | Persisted work product such as a plan or review                         |
| Factory evidence      | Persisted execution fact used by gates                                  |
| `status` packet       | Current resolved work, transition gates, context manifest, cycle counts |
| GitHub issue/project  | Product work and coarse board status; separate from delivery state      |

Discover ownership from latest `state-*` records across the fleet. Reject duplicate
or mismatched owners. Refresh per-item status before dispatch; a census or
`status-_factory` overview is not a schedule.
Item 77 has no retained factory state; the last historical fixture
(`scripts/fixtures/nightshift-legacy-baseline.json`) recorded `building`/`active`,
while product issue #77 closed through PR #137. Do not manufacture approvals or
mark the factory run terminal from the product issue. The tracked legacy
definition and its fan-out route were removed, but stored reports and the
historical fixture were not deleted. Do not submit item 77 to intake or
fan-out; factory and agent execution reject it, not the workflow input schema.
Retained summary failure reports that suggest `start` are not instructions to
restart it. An accidental local planning run for 77 was cancelled before its
planner returned; it did not establish a factory run or publish a plan.

## Workflows

All entries below are Swamp workflows. Validate before running; use resolved
inputs from current status for delivery stages.

| Workflow                                 | Purpose / principal inputs                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `nightshift-create-intake`               | Create issue and intake; `idempotencyKey`, `title`, optional `body`/`labels` |
| `nightshift-intake`                      | Refresh issue and create missing run; matching `workItem`, `issueNumber`     |
| `nightshift-plan-fanout`                 | Serial planning; `workItems` array                                           |
| `nightshift-build-fanout`                | At most two independent approved builds; `workItems` array                   |
| `nightshift-plan`, `nightshift-build`    | Per-item execution called by the fan-outs                                    |
| `nightshift-run-tests`                   | Execute approved plan selections and collect persisted receipts              |
| `nightshift-test-receipt`                | Run and verify one selected test; internal serial child                      |
| `nightshift-review`                      | Seven lanes; phase, subject, workspace, prior findings, receipts             |
| `nightshift-ship`                        | Consume exact-head managed verification and shipping evidence                |
| `nightshift-deployed-verification`       | Verify the merged PR revision                                                |
| `nightshift-close`, `nightshift-cleanup` | Complete factory closeout; preserve dirty source                             |
| `nightshift-record-failure`              | Persist diagnosed failure for the owning item                                |
| `nightshift-factory-repair`              | Explicit snapshot repair; `modelName`, `confirm=repair`                      |
| `nightshift-analytics`                   | Trigger retained-fleet report; existing `factory`, `workItem`                |
| `verification`                           | Full deterministic checks; `commit`, `baseCommit`, `subjectRoot`             |

Exact schemas live in [`workflows/`](../../workflows). There is no separate
Nightshift advance or project-projection workflow.

## Driver methods

| Method on the owning factory         | Use                                                      |
| ------------------------------------ | -------------------------------------------------------- |
| `status`                             | Refresh current requirements; always use before resuming |
| `record_dispatch`                    | Record intent before executing a work-bearing stage      |
| `record_artifact`, `record_evidence` | Persist products and execution facts                     |
| `resolve_findings`                   | Record finding resolutions without losing identity       |
| `approve`, `reject`                  | Record explicit human decisions on the actual subject    |
| `advance`                            | Take a permitted named transition                        |
| `summary`                            | Read recorded history                                    |
| `validate`, `describe`               | Validate or render a factory definition                  |

Discover arguments with `swamp model type describe @swamp/software-factory`.
The [factory skill](../../.agents/skills/software-factory/SKILL.md) defines the
full driver protocol. Approval gates include plan, ship, merge confirmation,
parked exits, and abort. Reset requires explicit human intent; it destroys progress.

## Review and test contracts

Lanes are accessibility, clean code, DDD, frontend, observability, security, and
test coverage. Each loads its [repository skill](../../.agents/skills) and the
[shared contract](../../agent-constraints/review.md). Unresolved high/critical
findings block; disputed findings remain unresolved; fixed findings do not block.
Review identity binds source/base/HEAD, policy and skill hashes, and actual
provider/model/variant from same-run invocations. Drift invalidates the round.

New plans contain one to ten literal test selections: `node`, `vitest`,
`playwright`, or `rust`. Rust adds `target` and optional integration `targetName`.
[Receipt reference](test-receipts.md) defines execution and freshness checks.
Existing snapshots without selections retain their original proof path.

| Test tier        | Command                                            | Purpose                                                        |
| ---------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| Fast Node        | `npm run test:unit`                                | Unit and contract checks without provisioning Swamp            |
| Factory          | `npm run with:swamp-local -- npm run test:factory` | Actual isolated Swamp server and template/workflow integration |
| Extensions       | `npm run test:extensions`                          | Deno model/report checks and native platform canaries          |
| Release          | `npm run test:release`                             | Packaging and license-generation integration                   |
| Client           | `npm --prefix client run test`                     | Client unit tests                                              |
| Browser          | `npm run test:visual`                              | Prepare assets and run browser acceptance                      |
| Prepared browser | `npm run test:visual:prepared`                     | Managed build already prepared assets; do not use stale output |

`npm test` retains Node, factory, release, and client tiers. Managed verification
also runs the other required controls; focused local passes do not replace it.

## Concurrency and host configuration

| Resource       | Limit                                                              |
| -------------- | ------------------------------------------------------------------ |
| Shared server  | One authenticated loopback `swamp serve` per checkout              |
| Planning       | One planner                                                        |
| Building       | Two independent builders                                           |
| Review         | Seven concurrent lanes in one review                               |
| Major phases   | Mutually exclusive per checkout                                    |
| Intake overlap | Only `nightshift-create-intake` / `nightshift-intake`, same server |

OpenCode routes to global `plan`, `build`, and `reviewer` agents. The installed
versions are pinned in [`upstream_extensions.json`](../../extensions/models/upstream_extensions.json).
Mac runtime assets are pinned in
[`swamp-local-runtime.json`](../../verification/swamp-local-runtime.json).
`SWAMP_SERVE_ADMIN` sets the server's admin principal; `SWAMP_SERVE_PORT` defaults
to 9090. Clients use `SWAMP_SERVE_URL` and `SWAMP_SERVER_TOKEN`.

## Source map

| Contract             | Source                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Lifecycle snapshot   | [`nightshift-template` definition](../../models/@swamp/software-factory/nightshift-template.yaml) |
| Review invariants    | [`agent-constraints/review.md`](../../agent-constraints/review.md)                                |
| Ship preparation     | [`agent-constraints/ship-prep.md`](../../agent-constraints/ship-prep.md)                          |
| Driver modes         | [Skill reference](../../.agents/skills/software-factory/references/nightshift-modes.md)           |
| Managed trust policy | [`verification/managed-policy.json`](../../verification/managed-policy.json)                      |
| Worker enforcement   | [`nightshift_agent.ts`](../../extensions/models/nightshift_agent.ts)                              |
| Analytics            | [`nightshift_review_analytics.ts`](../../extensions/reports/nightshift_review_analytics.ts)       |

GitHub owns `Todo`, `in-progress`, `await-merge`, and `done` board statuses.
Plan publication assigns the authenticated actor; the board workflow uses
`NIGHTSHIFT_PROJECT_TOKEN`. Configure remaining project transitions in GitHub's
Workflows UI. Factory stages never write the project Status field.
