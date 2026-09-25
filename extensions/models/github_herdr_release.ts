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

type TagResolver = (signal?: AbortSignal) => Promise<Map<string, string>>;

/**
 * Resolve every tag to its commit with one anonymous `git ls-remote`, which is
 * not subject to the 60-request REST limit. Peeled `^{}` entries win, so
 * annotated tags resolve to their commit rather than the tag object.
 */
export async function lsRemoteTags(signal?: AbortSignal) {
  const output = await new Deno.Command("git", {
    args: ["ls-remote", "--tags", `https://github.com/${REPOSITORY}.git`],
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  if (!output.success) throw new Error("git ls-remote of Herdr tags failed");
  return parseTagRefs(new TextDecoder().decode(output.stdout));
}

export function parseTagRefs(text: string) {
  const commits = new Map<string, string>();
  const peeled = new Set<string>();
  for (const line of text.split("\n")) {
    const [sha, ref] = line.trim().split("\t");
    if (!sha || !ref?.startsWith("refs/tags/") || !SHA.test(sha)) continue;
    const name = ref.slice("refs/tags/".length);
    if (name.endsWith("^{}")) {
      commits.set(name.slice(0, -3), sha);
      peeled.add(name.slice(0, -3));
    } else if (!peeled.has(name)) commits.set(name, sha);
  }
  return commits;
}

export async function discoverHerdrReleases(
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  resolveTags: TagResolver = lsRemoteTags,
) {
  const fetchedAt = new Date().toISOString();
  const raw = await githubJson(
    `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`,
    fetcher,
    signal,
  );
  if (!Array.isArray(raw))
    throw new Error("GitHub releases response is not an array");
  const commits = await resolveTags(signal);
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
    const commit = commits.get(value.tag_name);
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
