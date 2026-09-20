/** Validate review results once and retain both findings and applicability. */
import { z } from "npm:zod@4.4.3";

export const ReviewLane = z.enum([
  "test-coverage",
  "clean-code",
  "frontend",
  "ddd",
  "security",
  "accessibility",
  "observability",
]);
const Finding = z
  .object({
    id: z.string().min(1).max(160),
    severity: z.enum(["low", "medium", "high", "critical"]),
    description: z.string().min(1),
    requirement: z.string().min(1),
    evidence: z.string().min(1),
    impact: z.string().min(1),
    regressionProof: z.string().min(1),
    disposition: z.enum(["open", "fixed", "disputed"]),
  })
  .strict();
export const LaneReview = z
  .object({
    lane: ReviewLane,
    verdict: z.enum(["pass", "warn", "fail", "not-applicable"]),
    summary: z.string().min(1),
    findings: z.array(Finding),
  })
  .strict();
const Arguments = z.object({
  workItem: z.string().regex(/^[1-9][0-9]*$/),
  runId: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .max(128),
  phase: z.enum(["plan", "code"]),
  reviews: z.array(LaneReview).length(7),
  adjudicateDisputes: z.boolean().default(false),
});

export function normalizeReviews(reviews: z.infer<typeof LaneReview>[]) {
  const parsed = z.array(LaneReview).length(7).parse(reviews);
  const lanes = new Set(parsed.map((review) => review.lane));
  if (lanes.size !== 7)
    throw new Error("Every review lane must occur exactly once");
  const findings: Array<{
    id: string;
    severity: "low" | "medium" | "high" | "critical";
    category: string;
    description: string;
  }> = [];
  const ids = new Set<string>();
  for (const review of parsed) {
    const open = review.findings.filter(
      (finding) => finding.disposition !== "fixed",
    );
    const blocking = open.some((finding) =>
      ["high", "critical"].includes(finding.severity),
    );
    const warning = open.some((finding) => finding.severity === "medium");
    const expected = blocking ? "fail" : warning ? "warn" : "pass";
    if (review.verdict === "not-applicable") {
      if (review.findings.length)
        throw new Error(`${review.lane}: not-applicable must have no findings`);
    } else if (review.verdict !== expected) {
      throw new Error(
        `${review.lane}: verdict must match unresolved defect severity (${expected})`,
      );
    }
    for (const finding of review.findings) {
      const id = finding.id.startsWith(`${review.lane}:`)
        ? finding.id
        : `${review.lane}:${finding.id}`;
      if (ids.has(id)) throw new Error(`Duplicate finding identity: ${id}`);
      ids.add(id);
      if (finding.disposition === "fixed") continue;
      findings.push({
        id,
        severity: finding.severity,
        category: `${review.lane}:${["high", "critical"].includes(finding.severity) ? "fail" : finding.severity === "medium" ? "warn" : "pass"}`,
        description: `${finding.description}\nRequirement: ${finding.requirement}\nEvidence: ${finding.evidence}\nImpact: ${finding.impact}\nRegression proof: ${finding.regressionProof}\nDisposition: ${finding.disposition}`,
      });
    }
    // Lane observations preserve analytics coverage without asking agents to invent defects.
    findings.push({
      id: `LANE:${review.lane}`,
      severity: "low",
      category: `${review.lane}:${review.verdict === "not-applicable" ? "pass" : review.verdict}`,
      description: `${review.verdict}: ${review.summary}`,
    });
  }
  const verdict = parsed.some((review) => review.verdict === "fail")
    ? "fail"
    : parsed.some((review) => review.verdict === "warn")
      ? "warn"
      : "pass";
  findings.push({
    id: "ROUND",
    severity:
      verdict === "fail" ? "high" : verdict === "warn" ? "medium" : "low",
    category: `round:${verdict}`,
    description: `Review round: ${verdict}.`,
  });
  if (findings.length > 200)
    throw new Error("Review exceeds the 200-finding publication limit");
  return { schemaVersion: 2, verdict, reviews: parsed, findings };
}

/** Compare stable, namespaced defects; lane/round observations never adjudicate. */
export function repeatedDisputes(
  current: ReturnType<typeof normalizeReviews>["findings"],
  previous: Array<{
    id: string;
    severity: string;
    description: string;
    resolved?: boolean;
  }>,
) {
  const disputed = (finding: {
    severity: string;
    description: string;
    resolved?: boolean;
  }) =>
    !finding.resolved &&
    ["high", "critical"].includes(finding.severity) &&
    finding.description.endsWith("\nDisposition: disputed");
  const prior = new Set(previous.filter(disputed).map((finding) => finding.id));
  return current
    .filter((finding) => disputed(finding) && prior.has(finding.id))
    .map((finding) => finding.id)
    .sort();
}

export const extension = {
  type: "@swamp/software-factory",
  resources: {
    reviewRound: {
      description:
        "Validated independent lane results and factory-compatible findings",
      schema: z.object({
        workItem: z.string(),
        runId: z.string(),
        phase: z.enum(["plan", "code"]),
        schemaVersion: z.literal(2),
        verdict: z.enum(["pass", "warn", "fail"]),
        reviews: z.array(LaneReview),
        findings: z.array(
          z.object({
            id: z.string(),
            severity: z.string(),
            category: z.string(),
            description: z.string(),
          }),
        ),
      }),
      lifetime: "30d",
      garbageCollection: 100,
    },
  },
  methods: [
    {
      evaluate_review: {
        description:
          "Validate independent lane results and derive the worst unresolved verdict",
        arguments: Arguments,
        execute: async (
          args: z.infer<typeof Arguments>,
          context: {
            modelType?: unknown;
            modelId?: string;
            dataRepository?: {
              getContent(
                type: unknown,
                id: string,
                name: string,
              ): Promise<Uint8Array | null>;
            };
            writeResource: (
              spec: string,
              name: string,
              value: unknown,
            ) => Promise<unknown>;
          },
        ) => {
          const result = normalizeReviews(args.reviews);
          if (args.adjudicateDisputes) {
            if (
              !context.dataRepository ||
              !context.modelId ||
              !context.modelType
            )
              throw new Error(
                "Persisted prior review unavailable for adjudication",
              );
            const read = async (name: string) => {
              const bytes = await context.dataRepository!.getContent(
                context.modelType,
                context.modelId!,
                name,
              );
              return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
            };
            const stageId = `${args.phase}-review`;
            const [state, prior] = await Promise.all([
              read(`state-${args.workItem}`),
              read(`artifact-${args.workItem}-${stageId}`),
            ]);
            if (
              state?.workItem !== args.workItem ||
              state.stageId !== stageId ||
              state.status !== "active"
            )
              throw new Error("Adjudication requires the current review stage");
            const cycle = z
              .number()
              .int()
              .positive()
              .parse(state.cycles?.[stageId]);
            if (prior) {
              const previous = z
                .object({
                  workItem: z.literal(args.workItem),
                  stageId: z.literal(stageId),
                  cycle: z.number().int().positive(),
                  payload: z.object({
                    findings: z.array(
                      z.object({
                        id: z.string(),
                        severity: z.string(),
                        description: z.string(),
                        resolved: z.boolean().optional(),
                      }),
                    ),
                  }),
                })
                .parse(prior);
              if (previous.cycle < cycle) {
                const ids = repeatedDisputes(
                  result.findings,
                  previous.payload.findings,
                );
                if (ids.length)
                  result.findings.push({
                    id: "ADJUDICATION",
                    severity: "low",
                    category: "round:adjudication",
                    description: `Repeated blocking disputes require human adjudication: ${ids.join(", ")}. Blocking findings remain unresolved.`,
                  });
              }
            }
            if (result.findings.length > 200)
              throw new Error(
                "Review exceeds the 200-finding publication limit",
              );
          }
          const handle = await context.writeResource(
            "reviewRound",
            `review-${args.workItem}-${args.runId}`,
            {
              ...result,
              workItem: args.workItem,
              runId: args.runId,
              phase: args.phase,
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
