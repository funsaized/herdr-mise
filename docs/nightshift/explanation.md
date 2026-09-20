# Why Nightshift works this way

## State is separate from execution

A factory definition is a state machine stored as data. Each issue gets a snapshot
of `nightshift-template` in `nightshift-run-<N>`, with its own model lock, artifacts,
evidence, approvals, and journal. Updating the template affects new instances;
it does not silently change an in-flight agreement.

Swamp enforces gates and runs declarative workflows. A resident human or agent
driver chooses actionable work, records dispatch, executes the resolved work,
and advances permitted transitions. `swamp serve` is the shared executor, not a
background scheduler. Persisting through model methods makes recovery independent
of a particular chat session.

GitHub owns issues and project status. The factory owns delivery state. A merged
PR can close its issue while the factory still owes deployed verification. Keeping
those meanings separate avoids treating board movement as proof of execution.

## Concurrency follows shared resources

One factory per item removes the shared factory lock, but does not isolate the
whole machine. Planning uses one shared planner. Builders have separate sibling
workspaces, yet share host resources; two is the current supported cap. A review
has seven specialist lanes with independent invocation records and no sibling
findings visible during evaluation.

Planning, building, review, shipping, and verification may still contend over
checkout files, build outputs, ports, provider state, or runtime processes. Major
phases therefore stay mutually exclusive per checkout. Metadata-only intake is
the explicit exception. The limits are conservative operating policy, not a
measured optimum. Raising them requires isolation acceptance and contention data.

## Proof has several layers

A test receipt ties a real command and its result to source bytes, HEAD, toolchain,
and stored logs. It prevents accepting stale or empty execution. It cannot prove
that a test is meaningful or that candidate test code is honest. Reviewers assess
behavioral relevance and actual impact.

The seven reviews share typed findings, stable identities, severity rules, and
policy/source fingerprints. Repeated high-impact disputes go to a human rather
than cycling indefinitely or silently lowering severity. Selective review is
observed in shadow only: every lane still runs and missed blockers are retained.

Managed verification runs trusted controls from `main` against a separate exact
PR subject. A trusted gate validates the result and issues a receipt. Shipping
consumes that receipt rather than rerunning an unchanged full suite locally.
This is conventional hosted-CI assurance, not cryptographic proof of honest
execution; release builds and publication remain separate controls.

## Local macOS workers are a deliberate boundary

Seatbelt constrains provider processes without requiring Linux workers. The
trusted launcher controls policy; the candidate checkout cannot grant itself
write access. Read-only reviewers and writable actors have different profiles.
Hosted Linux CI serves a different purpose: reproducible managed verification.

A process sandbox is not a disposable host. Shared provider state, readable home
files, network access, credential brokers, and cancellation behavior limit its
assurance. [Known limits](limits.md) distinguish demonstrated enforcement from
unfinished acceptance. Passing a filesystem canary does not justify more workers
or a claim of complete credential isolation.
