import { discoverReleases } from "../reports/herdr_release_discovery.ts";
import { discoverHerdrReleases } from "../models/github_herdr_release.ts";
Deno.test("new public releases are candidates, never automatically supported", () => {
  const supported = ["0.8.2"];
  const release = (tag: string, publishedAt: string) => ({
    repository: "herdrdev/herdr",
    tag,
    commit: "a".repeat(40),
    publishedAt,
    fetchedAt: "2026-09-12T00:00:00.000Z",
  });
  const result = discoverReleases(
    [
      release("v0.8.2", "2026-08-01T00:00:00.000Z"),
      release("v0.9.0", "2026-09-01T00:00:00.000Z"),
    ],
    release("preview-2026-09-06-abcdef123456", "2026-09-06T00:00:00.000Z"),
    supported,
  );
  if (
    result.status !== "review-required" ||
    result.candidates[0]?.tag !== "v0.9.0" ||
    result.candidates[0]?.lane !== "unsupported-stable" ||
    result.preview?.lane !== "newest-preview" ||
    supported.join() !== "0.8.2"
  )
    throw new Error("discovery changed compatibility or lost a candidate");
});

Deno.test("release discovery dereferences tags and keeps only the newest preview", async () => {
  const sha = "b".repeat(40);
  const responses = new Map<string, unknown>([
    [
      "releases?per_page=100",
      [
        {
          tag_name: "v0.9.0",
          draft: false,
          prerelease: false,
          published_at: "2026-09-07T00:00:00Z",
        },
        {
          tag_name: "preview-2026-09-06-abcdef123456",
          draft: false,
          prerelease: true,
          published_at: "2026-09-06T00:00:00Z",
        },
        {
          tag_name: "preview-2026-09-08-fedcba654321",
          draft: false,
          prerelease: true,
          published_at: "2026-09-08T00:00:00Z",
        },
        {
          tag_name: "preview-bad",
          draft: false,
          prerelease: true,
          published_at: "2026-09-09T00:00:00Z",
        },
      ],
    ],
    [
      "git/ref/tags/v0.9.0",
      { ref: "refs/tags/v0.9.0", object: { type: "tag", sha } },
    ],
    [`git/tags/${sha}`, { object: { type: "commit", sha: "c".repeat(40) } }],
    [
      "git/ref/tags/preview-2026-09-06-abcdef123456",
      {
        ref: "refs/tags/preview-2026-09-06-abcdef123456",
        object: { type: "commit", sha: "d".repeat(40) },
      },
    ],
    [
      "git/ref/tags/preview-2026-09-08-fedcba654321",
      {
        ref: "refs/tags/preview-2026-09-08-fedcba654321",
        object: { type: "commit", sha: "e".repeat(40) },
      },
    ],
  ]);
  const fetcher = ((input: string | URL | Request) => {
    const url = String(input);
    const match = [...responses].find(([suffix]) => url.endsWith(suffix));
    return Promise.resolve(
      new Response(JSON.stringify(match?.[1]), { status: match ? 200 : 404 }),
    );
  }) as typeof fetch;
  const result = await discoverHerdrReleases(fetcher);
  if (result.stable[0]?.commit !== "c".repeat(40))
    throw new Error("annotated stable tag was not dereferenced");
  if (result.preview?.tag !== "preview-2026-09-08-fedcba654321")
    throw new Error("newest preview was not selected");
});
