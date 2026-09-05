type Release = { tagName: string; isDraft: boolean; isPrerelease: boolean };

export function discoverReleases(releases: Release[], supported: string[]) {
  const known = new Set(supported);
  const candidates = [
    ...new Set(
      releases
        .filter((release) => !release.isDraft && !release.isPrerelease)
        .map((release) => release.tagName.replace(/^v/, ""))
        .filter(
          (release) => /^\d+\.\d+\.\d+$/.test(release) && !known.has(release),
        ),
    ),
  ].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return {
    status: candidates.length ? "review-required" : "no-candidates",
    candidates,
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
      context.methodName !== "list_releases" ||
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
      if (value.repo !== "herdrdev/herdr" || !Array.isArray(value.releases))
        continue;
      const manifest = JSON.parse(
        await Deno.readTextFile(`${context.repoDir}/compatibility/herdr.json`),
      );
      const result = discoverReleases(
        value.releases,
        manifest.supported.map((entry: { release: string }) => entry.release),
      );
      return {
        markdown: `Herdr discovery: ${result.status}\n\nCandidates outside the verified matrix: ${result.candidates.join(", ") || "none"}.\n\n${result.nextAction}\n`,
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
