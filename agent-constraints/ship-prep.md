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
