# Tutorial: follow one work item

Learn how to discover a run, inspect its next requirement, and read the evidence
behind it. This walkthrough observes an existing item without dispatching agents,
approving gates, or advancing delivery. `status` refreshes a stored status record.

You need the [configured Mac runtime and server connection](setup.md), installed
extensions, and at least one existing factory run. Run commands from the repository
root. The commands below use the project-pinned CLI.

## 1. Find an existing item

```sh
npm run swamp:local -- model search --json
npm run swamp:local -- data query 'modelType == "@swamp/software-factory" && name.startsWith("state-")' \
  --select '{"modelName": modelName, "workItem": attributes.workItem, "stageId": attributes.stageId, "status": attributes.status}' --json
```

Choose a row. Normally issue `N` belongs to `nightshift-run-N`; legacy item 77
belongs to `the-nightshift`. `nightshift-template` is a definition, never a run.
If no rows exist, stop here; an operator must [intake approved work](operate.md#intake-an-issue).
Duplicate owners or an item/model mismatch require investigation before dispatch.

Set these variables to the values you actually found:

```sh
FACTORY=nightshift-run-123
ITEM=123
```

`123` is only an example; do not create a run to match it.

## 2. Ask what is required now

```sh
npm run swamp:local -- model method run "$FACTORY" status --input workItem="$ITEM"
npm run swamp:local -- data query "modelName == \"$FACTORY\" && name == \"status-$ITEM\"" \
  --select attributes --json
```

Read the current stage, resolved work specification, transition gates, and context
manifest. The census showed where the item was; this fresh packet tells a driver
what it may do next. A human gate is a real stop, even when all tests pass.

## 3. Follow an evidence pointer

Use a record name from the context manifest, rather than guessing an artifact:

```sh
RECORD=artifact-123-plan
npm run swamp:local -- data get "$FACTORY" "$RECORD" --json
npm run swamp:local -- model method run "$FACTORY" summary --input workItem="$ITEM"
```

Replace `RECORD` with the actual name. A plan describes the proposed work;
review findings assess it; evidence records execution. They serve different roles.
The summary lets you trace previous stages and retries without reconstructing
history from chat.

You have now followed identity → current requirements → recorded evidence.
The [operation guide](operate.md) explains how a driver safely acts on that state.
