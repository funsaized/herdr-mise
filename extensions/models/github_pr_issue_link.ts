/** Requires a pull request to close its Nightshift issue. */
import { z } from "npm:zod@4.4.3";

const REPOSITORY = "funsaized/herdr-mise";
const Repository = z.literal(REPOSITORY).default(REPOSITORY);
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
  workItem: z.string().regex(/^[1-9][0-9]{0,15}$/),
  repo: Repository,
  prUrl: PullRequestUrl,
});
const PullRequest = z.object({
  title: z.string(),
  body: z.string().nullable(),
  closingIssuesReferences: z.array(z.object({ number: z.number().int() })),
});

type Context = {
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

export function issueLinkedInPullRequest(output: string, workItem: string) {
  const pullRequest = PullRequest.parse(JSON.parse(output));
  const issueNumber = Number(workItem);
  if (
    pullRequest.closingIssuesReferences.some(
      (issue) => issue.number === issueNumber,
    )
  ) {
    return { issueNumber };
  }
  const text = `${pullRequest.title}\n${pullRequest.body ?? ""}`;
  const linked = [
    ...text.matchAll(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:funsaized\/herdr-mise)?#(\d+)\b/gi,
    ),
  ].some((match) => Number(match[1]) === issueNumber);
  if (linked) return { issueNumber };
  throw new Error(
    `pull request must link issue #${workItem} with a closing keyword`,
  );
}

async function gh(args: string[], signal?: AbortSignal) {
  const env = Object.fromEntries(
    [
      "GH_CONFIG_DIR",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "HOME",
      "PATH",
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
    linked_pull_request: {
      description: "A pull request that closes its Nightshift issue",
      schema: z.object({
        workItem: z.string(),
        prUrl: PullRequestUrl,
        issueNumber: z.number().int().positive(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: [
    {
      require_issue_link: {
        description: "Fail unless the pull request closes the work-item issue",
        arguments: Arguments,
        execute: async (args: z.infer<typeof Arguments>, context: Context) => {
          const linked = issueLinkedInPullRequest(
            await gh(
              [
                "pr",
                "view",
                args.prUrl,
                "--json",
                "title,body,closingIssuesReferences",
              ],
              context.signal,
            ),
            args.workItem,
          );
          const handle = await context.writeResource(
            "linked_pull_request",
            `linked-pr-${args.workItem}`,
            {
              workItem: args.workItem,
              prUrl: args.prUrl,
              issueNumber: linked.issueNumber,
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
