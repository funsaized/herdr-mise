# Ship-prep

Open the candidate pull request with a GitHub closing keyword for the factory work item:

```
gh pr create --body "Fixes #<workItem>"
```

Do not record `release-candidate` until `gh pr view <url> --json closingIssuesReferences` includes that issue.

Present the candidate pull request to the human for review. If they request
changes, record their feedback verbatim as `ship-feedback`, then take the manual
`request-rework` transition back to `building`. The normal build submission
returns the change through `code-review` before ship prep.

Record `release-candidate` from the worktree after the commit exists:

- `commit`: `git rev-parse HEAD` (full 40 hex). Never expand a short SHA.
- `baseCommit`: `git merge-base HEAD origin/main` (full 40 hex).
- `subjectRoot`: that worktree path.
- `branch`: `git branch --show-current`.
- `prUrl`: the pull request that closes the work item.

Do not record until `gh pr view <url> --json headRefOid,closingIssuesReferences`
shows `headRefOid == commit` and the issue is linked.

If the human pushes after recording, do not re-record over it from memory.
That is a candidate failure: record `shipping-run` failed with
`failureKind=candidate`, then rework through building and code review.
