import {
  assignIssueArgs,
  planComment,
  reviewComment,
} from "../models/github_issue_review.ts";

Deno.test("plan publication assigns the authenticated actor", () => {
  const args = assignIssueArgs("funsaized/herdr-mise", 106);
  if (
    args.join(" ") !==
    "issue edit 106 --repo funsaized/herdr-mise --add-assignee @me"
  ) {
    throw new Error(
      "plan publication must assign @me so board workflows can move in-progress",
    );
  }
});

Deno.test("plan comments include an idempotency marker and plan sections", () => {
  const comment = planComment({
    issue_number: 67,
    publication_key: "run-1",
    plan: {
      summary: "Decouple factory and board state",
      steps: ["Remove projection workflows"],
      testingStrategy: "Validate the factory definition",
      risks: [],
      outOfScope: ["GitHub Project configuration"],
    },
  });
  if (!comment.includes("<!-- nightshift-plan:run-1 -->")) {
    throw new Error("idempotency marker is missing");
  }
  if (!comment.includes("1. Remove projection workflows")) {
    throw new Error("plan step is missing");
  }
  if (!comment.includes("- GitHub Project configuration")) {
    throw new Error("out-of-scope item is missing");
  }
});

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
