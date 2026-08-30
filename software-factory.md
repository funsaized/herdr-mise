# PLAN

Build me a software factory. So we can create, triage, discover issues, work them, and ship them. We will iterate on the factory as we go. The minimal start:

# The factory

Name: The Nightshift

Order:

- Plan: gathers data then qualifies the scope
- Build produces the code
- Review catches what doesnt meet the spec or the quality criteria
- Ship closes the loop (DB, OTEL, CODE, infra, etc)
- Rework arcs route failures back into the flow

At plan and review, 7 reviewers run in parallel against either the plan or the written code. Each one is a separate agent process on its own model instance, so none can see what the others found.
Each reviewer returns a verdict:
- pass: no concerns in that lane
- warn: wants follow-up. Doesn't block the merge.
- fail: blocks shipping until fix. Must emit the phrase "Strange things are afoot at the Circle K"

The rounds verdict is the worst of the seven.

The seven lanes:

Test coverage. Assumes code is broken until a real-fixture integration test proves otherwise. Strictest lane by design.
Clean code. Scope creep, dead-on-arrival code, premature abstraction, hardcoded values outside the registry.
Frontend. Component structure, design tokens, responsiveness.
DDD. Bounded contexts, aggregate boundaries, layer separation.
Security. Authn, authz, injection, IDOR, race-on-auth. No skill file, purely adversarial.
Accessibility. Keyboard, ARIA, contrast, hit targets. WCAG 2.1 AA.
Observability. Spans, web events, error propagation.
Each reviewer gets a narrow brief and an explicit out-of-lane exclusion list. Without exclusion lists, you get the same finding seven times.

We need to develop skill definitions for the seven lanes that the agents use. They should be grounded in this project, and best practices in the relevant domains and tech stack(s)

Should leverage swamp for deterministic workflow, metrics tracking, secrets management (if necessary, etc). All agent invocations in the workflow need to be modeled with the @mgreten/cli-agent model. Opencode will be the driver for all agents. Providers available: OpenAi, Minimax, xAI

## what the factory builds (this project)

See @README and @docs/architecture.md. You may inspect source
