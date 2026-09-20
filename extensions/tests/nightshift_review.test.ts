import {
  normalizeReviews,
  ReviewLane,
  type LaneReview,
} from "../models/nightshift_review.ts";
import type { z } from "npm:zod@4.4.3";

const reviews = (): z.infer<typeof LaneReview>[] =>
  ReviewLane.options.map((lane) => ({
    lane,
    verdict: "pass",
    summary: "Inspected the changed surface; no defects.",
    findings: [],
  }));
const defect = {
  id: "pager-occlusion",
  severity: "high" as const,
  description: "Pager covers keyboard controls",
  requirement: "Controls remain reachable",
  evidence: "client/src/theme/global.css:627",
  impact: "Settings cannot be reached at narrow widths",
  regressionProof: "Run the 320px keyboard interaction case",
  disposition: "open" as "open" | "fixed" | "disputed",
};
function reject(input: z.infer<typeof LaneReview>[]) {
  try {
    normalizeReviews(input);
  } catch {
    return;
  }
  throw new Error("Invalid review accepted");
}

Deno.test("seven clean lanes need no invented defect or catchphrase", () => {
  const input = reviews();
  input[0].verdict = "not-applicable";
  const result = normalizeReviews(input);
  if (
    result.verdict !== "pass" ||
    result.findings.some((finding) => finding.severity !== "low")
  )
    throw new Error("Clean review blocked");
  if (result.reviews[0].verdict !== "not-applicable")
    throw new Error("Applicability lost");
});

Deno.test("historical pager regression remains blocking, including disputed disposition", () => {
  for (const disposition of ["open", "disputed"] as const) {
    const input = reviews();
    input[2].verdict = "fail";
    input[2].findings = [{ ...defect, disposition }];
    const result = normalizeReviews(input);
    if (
      result.verdict !== "fail" ||
      !result.findings.some(
        (finding) =>
          finding.id === "frontend:pager-occlusion" &&
          finding.severity === "high",
      )
    )
      throw new Error("Defect was demoted");
  }
});

Deno.test("fixed defects retain their history without remaining blockers", () => {
  const input = reviews();
  input[2].findings = [{ ...defect, disposition: "fixed" }];
  const result = normalizeReviews(input);
  if (
    result.verdict !== "pass" ||
    result.reviews[2].findings.length !== 1 ||
    result.findings.some((finding) => finding.id === "frontend:pager-occlusion")
  )
    throw new Error("Resolution lost or stale blocker retained");
});

Deno.test("prior published identities remain stable and aliases cannot duplicate a defect", () => {
  const input = reviews();
  input[2].verdict = "fail";
  input[2].findings = [{ ...defect, id: "frontend:pager-occlusion" }];
  const result = normalizeReviews(input);
  if (result.findings[2].id !== "frontend:pager-occlusion")
    throw new Error("Published identity changed during re-review");
  input[2].findings.push(defect);
  reject(input);
});

Deno.test("missing lanes, duplicate identities and inconsistent verdicts fail closed", () => {
  const duplicate = reviews();
  duplicate[0] = duplicate[1];
  reject(duplicate);
  const hidden = reviews();
  hidden[2].findings = [defect];
  reject(hidden);
  const repeated = reviews();
  repeated[2].verdict = "fail";
  repeated[2].findings = [defect, defect];
  reject(repeated);
  const inapplicable = reviews();
  inapplicable[2].verdict = "not-applicable";
  inapplicable[2].findings = [defect];
  reject(inapplicable);
});

Deno.test("adjudication uses stored disputed findings from distinct cycles without demotion", async () => {
  const { extension } = await import("../models/nightshift_review.ts");
  const evaluate = extension.methods[0].evaluate_review.execute;
  const input = reviews();
  input[2].verdict = "fail";
  input[2].findings = [{ ...defect, disposition: "disputed" }];
  const prior = normalizeReviews(input).findings;
  let cycle = 2;
  let previous = prior;
  let stored: ReturnType<typeof normalizeReviews> | undefined;
  const context = {
    modelType: "@swamp/software-factory",
    modelId: "fixture",
    dataRepository: {
      getContent: async (_type: unknown, _id: string, name: string) =>
        new TextEncoder().encode(
          JSON.stringify(
            name.startsWith("state-")
              ? {
                  workItem: "245",
                  stageId: "code-review",
                  status: "active",
                  cycles: { "code-review": cycle },
                }
              : {
                  workItem: "245",
                  stageId: "code-review",
                  cycle: 1,
                  payload: { findings: previous },
                },
          ),
        ),
    },
    writeResource: async (_spec: string, _name: string, value: unknown) => {
      stored = value as ReturnType<typeof normalizeReviews>;
      return {};
    },
  };
  const args = {
    workItem: "245",
    runId: "review-2",
    phase: "code" as const,
    reviews: input,
    adjudicateDisputes: true,
  };
  await evaluate(args, context);
  if (
    stored?.verdict !== "fail" ||
    !stored.findings.some((f) => f.id === "ADJUDICATION") ||
    !stored.findings.some(
      (f) => f.id === "frontend:pager-occlusion" && f.severity === "high",
    )
  )
    throw new Error("Repeated dispute was ignored or its blocker demoted");
  cycle = 1;
  await evaluate(args, context);
  if (stored?.findings.some((f) => f.id === "ADJUDICATION"))
    throw new Error("Same-cycle retry counted as two rounds");
  cycle = 2;
  previous = prior.map((f) => ({
    ...f,
    description: f.description.replace(
      "Disposition: disputed",
      "Disposition: open",
    ),
  }));
  await evaluate(args, context);
  if (stored?.findings.some((f) => f.id === "ADJUDICATION"))
    throw new Error("First dispute triggered adjudication");
  previous = prior;
  await evaluate({ ...args, adjudicateDisputes: false }, context);
  if (stored?.findings.some((f) => f.id === "ADJUDICATION"))
    throw new Error("Legacy routing changed");
  input[2].findings[0].disposition = "fixed";
  input[2].verdict = "pass";
  await evaluate(args, context);
  if (stored?.findings.some((f) => f.id === "ADJUDICATION"))
    throw new Error("Fixed defect still requested adjudication");
});
