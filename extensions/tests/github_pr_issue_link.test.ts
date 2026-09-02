import {
  assertCandidateHead,
  issueLinkedInPullRequest,
} from "../models/github_pr_issue_link.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function rejects(operation: () => unknown) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("expected operation to reject");
}

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: "feat: polish freezer",
    body: null,
    closingIssuesReferences: [],
    ...overrides,
  });
}

Deno.test("accepts a GitHub closing-issue reference", () => {
  const linked = issueLinkedInPullRequest(
    payload({ closingIssuesReferences: [{ number: 106 }] }),
    "106",
  );
  if (linked.issueNumber !== 106) {
    throw new Error("linked issue number was not preserved");
  }
});

Deno.test("accepts a closing keyword in the pull-request body", () => {
  const linked = issueLinkedInPullRequest(
    payload({ body: "Fixes #106\n\nPolish the freezer split." }),
    "106",
  );
  if (linked.issueNumber !== 106) {
    throw new Error("Fixes keyword did not link the issue");
  }
});

Deno.test("rejects a pull request that does not close the work item", () => {
  rejects(() => issueLinkedInPullRequest(payload({ body: "See #106" }), "106"));
  rejects(() =>
    issueLinkedInPullRequest(
      payload({ closingIssuesReferences: [{ number: 99 }] }),
      "106",
    ),
  );
});

Deno.test("accepts a matching candidate head", () => {
  assertCandidateHead(COMMIT, COMMIT);
});

Deno.test("rejects a mismatched candidate head", () => {
  rejects(() =>
    assertCandidateHead("ffffffffffffffffffffffffffffffffffffffff", COMMIT),
  );
});

Deno.test("rejects a missing candidate head", () => {
  rejects(() => assertCandidateHead(undefined, COMMIT));
});
