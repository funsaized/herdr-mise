# Factory instance evidence

Verified with Swamp `20260926.025243.0-sha.0f086bc8` and
`@swamp/software-factory` `2026.06.24.1` by
`scripts/nightshift-factory-instance.integration.test.mjs`.

- Swamp refuses to persist a definition whose `${{ }}` text arrived as evaluated
  workflow data. Stage bindings such as `${{ self.name }}` are evaluated by the
  factory engine at dispatch, so runtime factories are no longer created by a
  workflow step copying `model.<template>.definition.globalArguments`.
- `scripts/lib/factory-instance.mjs` creates each instance with
  `swamp model create --global-arg` from the template's global arguments; the
  copy is concrete and preserves nested `self` bindings.
- Re-running creation for an item is a no-op that keeps a version-1 state; a
  second model cannot claim an owned item; distinct items get distinct IDs.
  Creation is single-writer: concurrent creates of one name race on the file.
- Explicit repair (`swamp model edit <name> --json` with the template's global
  arguments) retains model ID and run data.
- Empty type-default work-item summaries are not persisted after `start`,
  `status`, `record_dispatch`, `record_artifact`, or `advance`. `summary`
  persists the supported history report.
