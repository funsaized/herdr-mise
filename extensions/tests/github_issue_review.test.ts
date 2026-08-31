import { reviewComment } from "../models/github_issue_review.ts";

Deno.test("review comments include an idempotency marker and findings", () => {
  const comment = reviewComment({
    issue_number: 67,
    phase: "plan",
    publication_key: "run-1",
    findings: [
      {
        id: "DDD-1",
        severity: "high",
        category: "ddd:fail",
        description: "Wrong bounded context",
      },
    ],
  });
  if (!comment.includes("<!-- nightshift-review:plan:run-1 -->")) {
    throw new Error("idempotency marker is missing");
  }
  if (!comment.includes("**HIGH DDD-1** (ddd:fail): Wrong bounded context")) {
    throw new Error("finding is missing");
  }
});
