/** Adds credential-free, immutable Herdr release discovery to @webframp/github. */
import { z } from "npm:zod@4.4.3";

const REPOSITORY = "herdrdev/herdr";
const SHA = /^[0-9a-f]{40}$/;
const STABLE_TAG = /^v?\d+\.\d+\.\d+$/;
const PREVIEW_TAG = /^preview-\d{4}-\d{2}-\d{2}-[0-9a-f]{12}$/;

const Release = z.object({
  repository: z.literal(REPOSITORY),
  tag: z.string(),
  commit: z.string().regex(SHA),
  publishedAt: z.iso.datetime(),
  fetchedAt: z.iso.datetime(),
});

type ApiRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
};
type Fetcher = typeof fetch;

async function githubJson(url: string, fetcher: Fetcher, signal?: AbortSignal) {
  const response = await fetcher(url, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!response.ok)
    throw new Error(`public GitHub API returned ${response.status}`);
  return await response.json();
}

async function tagCommit(tag: string, fetcher: Fetcher, signal?: AbortSignal) {
  const ref = (await githubJson(
    `https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
    fetcher,
    signal,
  )) as { ref?: unknown; object?: { type?: unknown; sha?: unknown } };
  if (ref.ref !== `refs/tags/${tag}` || !ref.object) return null;
  let object = ref.object;
  for (let depth = 0; depth < 5 && object.type === "tag"; depth++) {
    if (typeof object.sha !== "string" || !SHA.test(object.sha)) return null;
    const annotated = (await githubJson(
      `https://api.github.com/repos/${REPOSITORY}/git/tags/${object.sha}`,
      fetcher,
      signal,
    )) as { object?: { type?: unknown; sha?: unknown } };
    if (!annotated.object) return null;
    object = annotated.object;
  }
  return object.type === "commit" &&
    typeof object.sha === "string" &&
    SHA.test(object.sha)
    ? object.sha
    : null;
}

export async function discoverHerdrReleases(
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
) {
  const fetchedAt = new Date().toISOString();
  const raw = await githubJson(
    `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`,
    fetcher,
    signal,
  );
  if (!Array.isArray(raw))
    throw new Error("GitHub releases response is not an array");
  const releases: Array<z.infer<typeof Release> & { prerelease: boolean }> = [];
  for (const value of raw as ApiRelease[]) {
    if (
      value.draft !== false ||
      typeof value.tag_name !== "string" ||
      typeof value.published_at !== "string" ||
      Number.isNaN(Date.parse(value.published_at)) ||
      (value.prerelease !== false && value.prerelease !== true) ||
      (value.prerelease
        ? !PREVIEW_TAG.test(value.tag_name)
        : !STABLE_TAG.test(value.tag_name))
    )
      continue;
    const commit = await tagCommit(value.tag_name, fetcher, signal);
    if (!commit) continue;
    releases.push({
      repository: REPOSITORY,
      tag: value.tag_name,
      commit,
      publishedAt: new Date(value.published_at).toISOString(),
      fetchedAt,
      prerelease: value.prerelease,
    });
  }
  const stable = releases
    .filter((release) => !release.prerelease)
    .map((release) => Release.parse(release));
  const preview = releases
    .filter((release) => release.prerelease)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
  return {
    repository: REPOSITORY,
    stable,
    preview: preview ? Release.parse(preview) : null,
    fetchedAt,
  };
}

type Context = {
  signal?: AbortSignal;
  writeResource: (
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

export const extension = {
  type: "@webframp/github",
  resources: {
    herdrReleaseDiscovery: {
      description: "Immutable stable releases and newest Herdr preview",
      schema: z.object({
        repository: z.literal(REPOSITORY),
        stable: z.array(Release),
        preview: Release.nullable(),
        fetchedAt: z.iso.datetime(),
      }),
      lifetime: "30d",
      garbageCollection: 12,
    },
  },
  methods: [
    {
      discover_herdr_releases: {
        description:
          "Discover immutable public stable and preview Herdr releases",
        arguments: z.object({}),
        execute: async (_args: Record<string, never>, context: Context) => {
          const value = await discoverHerdrReleases(fetch, context.signal);
          const handle = await context.writeResource(
            "herdrReleaseDiscovery",
            "herdr-release-discovery",
            value,
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
