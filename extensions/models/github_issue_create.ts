/** Adds issue creation to the read-only @webframp/github model. */
import { z } from "npm:zod@4.4.3";

const REPOSITORY = "funsaized/herdr-mise";
const Repository = z.literal(REPOSITORY).default(REPOSITORY);
const IssueUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.origin === "https://github.com" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
const Arguments = z.object({
  repo: Repository,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  title: z.string().min(1).max(256),
  body: z.string().max(65000).default(""),
  labels: z.array(z.string().min(1)).max(20).default([]),
});
const ExistingIssues = z.array(
  z.array(
    z.object({
      body: z.string().nullable(),
      created_at: z.iso.datetime(),
      html_url: IssueUrl,
      labels: z.array(z.object({ name: z.string().min(1) })),
      number: z.number().int().positive(),
      pull_request: z.unknown().optional(),
      title: z.string().min(1),
    }),
  ),
);

type Context = {
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

export function parseIssueUrl(output: string, repo: string) {
  let url: URL;
  try {
    url = new URL(output.trim());
  } catch {
    throw new Error("gh returned an unexpected issue URL");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const [owner, name] = repo.split("/");
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    segments.length !== 4 ||
    segments[0] !== owner ||
    segments[1] !== name ||
    segments[2] !== "issues" ||
    !/^[1-9]\d*$/.test(segments[3])
  ) {
    throw new Error("gh returned an unexpected issue URL");
  }
  return { number: Number(segments[3]), url: url.toString() };
}

function marker(idempotencyKey: string) {
  return `<!-- nightshift-idempotency:${idempotencyKey} -->`;
}

export function findExistingIssue(
  output: string,
  repo: string,
  idempotencyKey: string,
) {
  const issue = ExistingIssues.parse(JSON.parse(output))
    .flat()
    .find(
      (candidate) =>
        candidate.pull_request === undefined &&
        candidate.body?.includes(marker(idempotencyKey)),
    );
  if (!issue) return undefined;
  const parsedUrl = parseIssueUrl(issue.html_url, repo);
  return {
    repo,
    ...parsedUrl,
    title: issue.title,
    labels: issue.labels.map((label) => label.name),
    createdAt: issue.created_at,
    created: false,
  };
}

async function gh(args: string[], signal?: AbortSignal) {
  const allowedEnvironment = [
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HOME",
    "XDG_CONFIG_HOME",
  ];
  const env = Object.fromEntries(
    allowedEnvironment.flatMap((name) => {
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
    created_issue: {
      description: "A newly created GitHub issue",
      schema: z.object({
        repo: Repository,
        number: z.number().int().positive(),
        title: z.string().min(1),
        url: IssueUrl,
        labels: z.array(z.string().min(1)),
        createdAt: z.iso.datetime(),
        created: z.boolean(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: [
    {
      create_issue: {
        description: "Create one GitHub issue using the authenticated gh CLI",
        arguments: Arguments,
        execute: async (args: z.infer<typeof Arguments>, context: Context) => {
          const existing = findExistingIssue(
            await gh(
              [
                "api",
                "--paginate",
                "--slurp",
                `repos/${args.repo}/issues?state=all&per_page=100`,
              ],
              context.signal,
            ),
            args.repo,
            args.idempotencyKey,
          );
          const resourceName = `created-issue-${args.idempotencyKey}`;
          if (existing) {
            const handle = await context.writeResource(
              "created_issue",
              resourceName,
              existing,
            );
            return { dataHandles: [handle] };
          }

          const commandArgs = [
            "issue",
            "create",
            "--repo",
            args.repo,
            "--title",
            args.title,
            "--body",
            `${args.body}${args.body ? "\n\n" : ""}${marker(args.idempotencyKey)}`,
          ];
          for (const label of args.labels) commandArgs.push("--label", label);

          const issue = parseIssueUrl(
            await gh(commandArgs, context.signal),
            args.repo,
          );
          const handle = await context.writeResource(
            "created_issue",
            resourceName,
            {
              repo: args.repo,
              ...issue,
              title: args.title,
              labels: args.labels,
              createdAt: new Date().toISOString(),
              created: true,
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
