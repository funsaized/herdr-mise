import { discoverReleases } from "../reports/herdr_release_discovery.ts";
Deno.test("new public releases are candidates, never automatically supported", () => {
  const supported = ["0.8.2"];
  const result = discoverReleases(
    [
      { tagName: "v0.8.2", isDraft: false, isPrerelease: false },
      { tagName: "v0.9.0", isDraft: false, isPrerelease: false },
      { tagName: "v1.0.0", isDraft: true, isPrerelease: false },
      { tagName: "v1.0.0-rc.1", isDraft: false, isPrerelease: true },
    ],
    supported,
  );
  if (
    result.status !== "review-required" ||
    result.candidates.join() !== "0.9.0" ||
    supported.join() !== "0.8.2"
  )
    throw new Error("discovery changed compatibility or lost a candidate");
});
