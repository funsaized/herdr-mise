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
