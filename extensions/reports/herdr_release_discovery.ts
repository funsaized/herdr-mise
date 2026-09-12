type Release = {
  repository: string;
  tag: string;
  commit: string;
  publishedAt: string;
  fetchedAt: string;
};

export function discoverReleases(
  stable: Release[],
  preview: Release | null,
  supported: string[],
) {
  const known = new Set(supported);
  const candidates = stable
    .filter((release) => !known.has(release.tag.replace(/^v/, "")))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map((release) => ({ ...release, lane: "unsupported-stable" as const }));
  return {
    status: candidates.length || preview ? "review-required" : "no-candidates",
    candidates,
    preview: preview ? { ...preview, lane: "newest-preview" as const } : null,
    supported,
    nextAction:
      "Review each candidate's immutable source and sanitized fixtures before changing compatibility/herdr.json.",
  };
}

type Context = {
  repoDir: string;
  modelType: unknown;
  modelId: string;
  methodName: string;
  executionStatus: string;
  dataHandles: { name: string; version?: number }[];
  dataRepository: {
    getContent(
      type: unknown,
      model: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
};
export const report = {
  name: "@funsaized/herdr-release-discovery",
  description:
    "Compare fetched public Herdr release metadata with the verified matrix; never expand support automatically.",
  scope: "method",
  labels: ["compatibility"],
  async execute(context: Context) {
    if (
      context.methodName !== "discover_herdr_releases" ||
      context.executionStatus !== "succeeded"
    )
      return {
        markdown:
          "Release discovery unavailable: source fetch did not succeed.",
        json: { status: "unavailable" },
      };
    for (const handle of context.dataHandles) {
      const bytes = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        handle.name,
        handle.version,
      );
      if (!bytes) continue;
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (
        value.repository !== "herdrdev/herdr" ||
        !Array.isArray(value.stable) ||
        !(value.preview === null || typeof value.preview === "object")
      )
        continue;
      const manifest = JSON.parse(
        await Deno.readTextFile(`${context.repoDir}/compatibility/herdr.json`),
      );
      const result = discoverReleases(
        value.stable,
        value.preview,
        manifest.supported.map((entry: { release: string }) => entry.release),
      );
      return {
        markdown: `Herdr discovery: ${result.status}\n\nUnsupported stable candidates: ${result.candidates.map((candidate) => candidate.tag).join(", ") || "none"}.\n\nNewest preview: ${result.preview?.tag ?? "none"}.\n\n${result.nextAction}\n`,
        json: {
          ...result,
          source: { name: handle.name, version: handle.version },
          fetchedAt: value.fetchedAt,
        },
      };
    }
    throw new Error("Herdr release output missing from this execution");
  },
};
