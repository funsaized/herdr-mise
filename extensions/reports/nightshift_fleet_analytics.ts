/** Fleet entry point for the existing analytics engine; no lifecycle mutation. */
import {
  analyzeNightshift,
  loadFactoryInput,
  renderMarkdown,
  type ReportContext,
} from "./nightshift_review_analytics.ts";

export const report = {
  name: "@funsaized/nightshift-fleet-analytics",
  description:
    "Retained fleet analytics using the shared Nightshift report engine",
  scope: "workflow",
  labels: ["software-factory", "nightshift", "analytics"],
  execute: async (
    context: Pick<ReportContext, "dataRepository"> & {
      workflowStatus: string;
      workflowRunId: string;
    },
  ) => {
    if (context.workflowStatus !== "succeeded")
      throw new Error("Fleet report requires a successful summary trigger");
    const analytics = analyzeNightshift(
      await loadFactoryInput({
        dataRepository: context.dataRepository,
        modelType: "@swamp/software-factory",
      }),
    );
    return {
      markdown: renderMarkdown(analytics),
      json: {
        scope: "retained-fleet",
        workflowRunId: context.workflowRunId,
        ...analytics,
      },
    };
  },
};
