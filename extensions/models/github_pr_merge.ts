/** Adds exact merged pull-request identity to @webframp/github. */
import { z } from "npm:zod@4.4.3";

const REPOSITORY = "funsaized/herdr-mise";
const Repository = z.literal(REPOSITORY).default(REPOSITORY);
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const PullRequestUrl = z.url().refine((value) => {
  const url = new URL(value);
  const segments = url.pathname.split("/").filter(Boolean);
  return (
    url.origin === "https://github.com" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    segments.length === 4 &&
    `${segments[0]}/${segments[1]}` === REPOSITORY &&
    segments[2] === "pull" &&
    /^[1-9]\d*$/.test(segments[3])
  );
});
const Arguments = z.object({
  workItem: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/),
  repo: Repository,
  prUrl: PullRequestUrl,
});
const Response = z.object({
  html_url: PullRequestUrl,
  merged: z.literal(true),
  merged_at: z.iso.datetime(),
  merge_commit_sha: Sha,
  number: z.number().int().positive(),
});

type Context = {
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

export function parseMergedPullRequest(output: string, workItem: string) {
  const pullRequest = Response.parse(JSON.parse(output));
  return {
    workItem,
    prNumber: pullRequest.number,
    prUrl: pullRequest.html_url,
    mergeCommit: pullRequest.merge_commit_sha,
    mergedAt: pullRequest.merged_at,
  };
}

async function gh(args: string[], signal?: AbortSignal) {
  const env = Object.fromEntries(
    [
      "GH_CONFIG_DIR",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "HOME",
      "XDG_CONFIG_HOME",
    ].flatMap((name) => {
      const value = Deno.env.get(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
  env.GH_PROMPT_DISABLED = "1";
  const result = await new Deno.Command("gh", {
    args,
    clearEnv: true,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  if (!result.success) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() || `gh ${args[0]} failed`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

export const extension = {
  type: "@webframp/github",
  resources: {
    merged_pull_request: {
      description: "Exact identity of a merged pull request",
      schema: z.object({
        workItem: z.string(),
        prNumber: z.number().int().positive(),
        prUrl: PullRequestUrl,
        mergeCommit: Sha,
        mergedAt: z.iso.datetime(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: [
    {
      get_merged_pr: {
        description: "Read the exact merge commit for a merged pull request",
        arguments: Arguments,
        execute: async (args: z.infer<typeof Arguments>, context: Context) => {
          const url = new URL(args.prUrl);
          const prNumber = url.pathname.split("/").filter(Boolean)[3];
          const merged = parseMergedPullRequest(
            await gh(
              ["api", `repos/${args.repo}/pulls/${prNumber}`],
              context.signal,
            ),
            args.workItem,
          );
          const handle = await context.writeResource(
            "merged_pull_request",
            `merged-pr-${args.workItem}`,
            merged,
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
