# Factory instance Phase 0 evidence

Verified with Swamp `20260904.044433.0-sha.ab26e35b` and
`@swamp/software-factory` `2026.06.24.1` by
`scripts/nightshift-factory-instance.integration.test.mjs`.

- `model.phase0-factory-template.definition.globalArguments` is the accepted
  template accessor. The copy is concrete and preserves nested `self` bindings.
- A missing-model `data.latest()` lookup returns `null` through `swamp serve`.
- Concurrent same-name creation produces one model and one version-1 state;
  distinct names create distinct model IDs and states.
- Supplying `globalArgs` for an existing auto-definition overwrites its snapshot
  before the requested method runs, including when duplicate `start` then fails.
- Explicit repair through `phase0-factory-instance-repair` retains model ID and
  run data. Its workflow run is the audit record.
- Empty type-default work-item summaries are not persisted after `start`,
  `status`, `record_dispatch`, `record_artifact`, or `advance`. `summary`
  persists the supported history report. Runtime auto-definitions still cannot
  opt into Nightshift analytics or flow-metrics report policy.

## Accepted creation policy

The intake workflow cannot distinguish an absent definition from an existing
auto-definition with no state before direct execution. Because direct execution
overwrites existing `globalArgs`, Nightshift accepts a controlled single-writer
policy for intake. Only the serve-backed Nightshift intake workflow may create
runtime definitions; operators must use the explicit repair workflow for an
existing definition with no state.

This does not make creation atomic. Two uncontrolled callers can both observe an
absent state and the second can resend the snapshot after the first creates the
definition. Upgrade to atomic create-if-absent when intake becomes multi-writer
or externally callable.
