# Review calibration cases

These cases were read from retained Swamp artifact versions on September 20.
They are retrospective policy examples, not a model-quality benchmark or a
claim about escaped defects. The assessment below applies the current review
contract to the evidence in the historical finding; it does not reconstruct the
entire historical source tree. No stored finding or approval was changed.

Retrieve a source with `swamp data get nightshift-run-<item>
artifact-<item>-code-review --version <version> --json`. Historical identifiers
such as `FE-1` were reused for different defects across rounds; they cannot serve
as stable cross-round identities for adjudication or reuse.

| Item / version / finding      | Observed evidence                                                                                              | Current policy assessment                                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 179 / 1 / FE-1                | Pager obscures blocked pose, elapsed time and identity at dense viewport sizes.                                | High frontend defect: observable loss of required information; prove geometry and reachable controls at those sizes.                                                                              |
| 179 / 2 / TC-1                | Actual browser test fails: station bottom 385.5 exceeds the 360px viewport.                                    | High behavioral regression; passing unrelated Vitest cases do not negate the browser failure.                                                                                                     |
| 179 / 3 / CC-1                | Two literals duplicate an existing station-height token; no broken behavior or concrete drift is demonstrated. | A maintenance observation, not high on this evidence alone. Name a consequential violation before blocking delivery.                                                                              |
| 179 / 10 / CC-1               | Chrome counts visible blocked agents using list order while the scene uses stable slot order.                  | High correctness defect despite its clean-code lane: the projections can disagree after roster reorder. Primary ownership is the state/projection boundary.                                       |
| 179 / 15 / CC-1               | An unread ref and its prop remain after an effect was removed.                                                 | Low cleanup observation on the recorded evidence; do not turn the preference into a blocking correctness claim.                                                                                   |
| 181 / 1 / FE-1                | Four inspection lines are rendered into a three-row compact panel.                                             | High frontend defect: locator/ticket information is clipped in supported terminal sizes.                                                                                                          |
| 181 / 3 / A11Y-1              | Distinct controls with the same name/workspace and no pane ID have identical accessible names.                 | High accessibility defect; the missing optional pane ID needs an independent disambiguation path.                                                                                                 |
| 181 / 5 / TC-1                | A helper test uses long locators, but rendered TestBackend fixtures still use short locators.                  | Required boundary proof is missing. A passing helper test does not exercise the changed clipping path.                                                                                            |
| 181 / 18–19 / TC-1            | Port 4174 prevents the browser test from executing; later recorded resolution cites a passing exact rerun.     | Infrastructure failure and missing proof initially block acceptance, but are not evidence of a product regression. Resolve from fresh execution proof; do not request speculative source changes. |
| 179 / 11 / TC-1, FE-1, A11Y-1 | Three lanes report the same measured 2px station/pager overlap.                                                | Preserve the blocker under its primary owner and corroborate elsewhere. Three reports are not three independent defects.                                                                          |

The typed evaluator checks completeness, verdict/severity consistency and stable
identity; it cannot determine whether natural-language evidence actually proves
an impact. Reviewers still make that judgment. The repeated-dispute route parks
unresolved high/critical disagreements for a human after two distinct cycles;
it does not automatically demote them.

Every full review now records a subject/base/source fingerprint, hashes of the
trusted review policy and seven skills, and the actual provider/model/variant
from completed invocations. Source or control changes during review invalidate
the round. Documentation-only routing is a conservative **shadow recommendation**:
all seven lanes execute, no receipt is reused, and blocking findings from lanes
outside the recommendation are retained as `shadow.missedBlockingFindings`.
Plan, unknown, shared-boundary and trust-boundary changes recommend all lanes.

Read the record with `swamp data get <factory>
review-identity-<item>-<run-id> --json`. Do not enable selective execution from a
single clean shadow result. Comparable completed pilot items, independent case
replay and controlled timing measurements remain acceptance work.
