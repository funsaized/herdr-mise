# Nightshift software factory

Nightshift takes a GitHub issue through planning, reviewed implementation,
managed verification, and post-merge checks. Swamp stores the state and enforces
gates; a human or agent driver moves the work forward. Starting the server alone
does not start autonomous work.

Choose the page that matches your purpose. These docs use
[Diátaxis](https://diataxis.fr/) to separate learning, tasks, facts, and reasoning.

| Your need                                           | Start here                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| Learn by inspecting an existing run                 | [Tutorial: follow one work item](tutorial.md)                                   |
| Set up the Mac host and authenticated server        | [How to set up Nightshift](setup.md)                                            |
| Plan, build, review, deliver, or recover work       | [How to operate the factory](operate.md)                                        |
| Find commands, owners, workflows, and limits        | [Reference](reference.md)                                                       |
| Understand the architecture and tradeoffs           | [Explanation](explanation.md)                                                   |
| Understand test proof and reviewer decisions        | [Test receipts](test-receipts.md) · [Review calibration](review-calibration.md) |
| Inspect worker guarantees and unfinished acceptance | [Worker isolation](worker-isolation.md) · [Known limits](limits.md)             |
| Understand the trusted CI gate                      | [Managed verification reference](managed-verification.md)                       |

For ordinary product contributions, start with [CONTRIBUTING](../../CONTRIBUTING.md).
For the application itself, use [Architecture](../architecture.md) and
[Operations](../operations.md). Current work is tracked in
[GitHub issues](https://github.com/funsaized/herdr-mise/issues); superseded plans
and audit diaries remain available in Git history.
