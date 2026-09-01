# Ship-prep

Open the candidate pull request with a GitHub closing keyword for the factory work item:

```
gh pr create --body "Fixes #<workItem>"
```

Do not record `release-candidate` until `gh pr view <url> --json closingIssuesReferences` includes that issue.
