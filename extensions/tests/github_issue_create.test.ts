import {
  findExistingIssue,
  parseIssueUrl,
} from "../models/github_issue_create.ts";

function rejects(operation: () => unknown) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("expected operation to reject");
}

Deno.test("accepts only a matching GitHub issue URL", () => {
  const issue = parseIssueUrl(
    "https://github.com/funsaized/herdr-mise/issues/42\n",
    "funsaized/herdr-mise",
  );
  if (issue.number !== 42) throw new Error("issue number was not parsed");

  rejects(() =>
    parseIssueUrl(
      "https://github.com/other/project/issues/42",
      "funsaized/herdr-mise",
    ),
  );
  rejects(() =>
    parseIssueUrl(
      "https://evil.example/funsaized/herdr-mise/issues/42",
      "funsaized/herdr-mise",
    ),
  );
  rejects(() =>
    parseIssueUrl(
      "https://user:token@github.com/funsaized/herdr-mise/issues/42",
      "funsaized/herdr-mise",
    ),
  );
  rejects(() => parseIssueUrl("not a URL", "funsaized/herdr-mise"));
});

Deno.test("finds an existing issue by idempotency marker", () => {
  const existing = findExistingIssue(
    JSON.stringify([
      [
        {
          body: "Details\n\n<!-- nightshift-idempotency:request-42 -->",
          created_at: "2026-08-29T20:00:00Z",
          html_url: "https://github.com/funsaized/herdr-mise/issues/42",
          labels: [{ name: "bug" }],
          number: 42,
          title: "Broken thing",
        },
      ],
    ]),
    "funsaized/herdr-mise",
    "request-42",
  );
  if (existing?.number !== 42 || existing.created !== false) {
    throw new Error("existing issue was not recovered");
  }
});
