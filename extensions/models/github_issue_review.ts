/** Publishes idempotent Nightshift adversarial-review results to GitHub issues. */
import { z } from "npm:zod@4.4.3";

const Finding = z.object({
  id: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  description: z.string().min(1),
  category: z.string().optional(),
});
const Arguments = z.object({
  issue_number: z.number().int().positive(),
  phase: z.enum(["plan", "code"]),
  publication_key: z.string().min(1).max(128),
  findings: z.array(Finding).min(1).max(200),
});
type Arguments = z.infer<typeof Arguments>;
const Plan = z.object({
  summary: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  testingStrategy: z.string().min(1),
  risks: z.array(z.string().min(1)),
  outOfScope: z.array(z.string().min(1)),
});
const PlanArguments = z.object({
  issue_number: z.number().int().positive(),
  publication_key: z.string().min(1).max(128),
  plan: Plan,
});
type PlanArguments = z.infer<typeof PlanArguments>;

type Context = {
  globalArgs: Record<string, unknown>;
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

function githubEnvironment() {
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
  return env;
}

async function gh(args: string[], signal?: AbortSignal) {
  const result = await new Deno.Command("gh", {
    args,
    clearEnv: true,
    env: githubEnvironment(),
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
  return new TextDecoder().decode(result.stdout);
}

export function reviewComment(args: Arguments) {
  const marker = `<!-- nightshift-review:${args.phase}:${args.publication_key} -->`;
  const heading = args.phase === "plan" ? "Plan review" : "Code review";
  const findings = args.findings
    .map(
      (finding) =>
        `- **${finding.severity.toUpperCase()} ${finding.id}**${finding.category ? ` (${finding.category})` : ""}: ${finding.description}`,
    )
    .join("\n");
  return `${marker}\n### Nightshift ${heading}\n\n${findings}`.slice(0, 60_000);
}

export function planComment(args: PlanArguments) {
  const list = (items: string[]) =>
    items.length === 0 ? "- None" : items.map((item) => `- ${item}`).join("\n");
  const steps = args.plan.steps
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
  return `<!-- nightshift-plan:${args.publication_key} -->
### Nightshift implementation plan

${args.plan.summary}

#### Steps

${steps}

#### Testing

${args.plan.testingStrategy}

#### Risks

${list(args.plan.risks)}

#### Out of scope

${list(args.plan.outOfScope)}`.slice(0, 60_000);
}

async function publishComment(
  repo: string,
  issueNumber: number,
  marker: string,
  body: string,
  signal?: AbortSignal,
) {
  const comments = z
    .array(z.array(z.object({ body: z.string() })))
    .parse(
      JSON.parse(
        await gh(
          [
            "api",
            `repos/${repo}/issues/${issueNumber}/comments`,
            "--paginate",
            "--slurp",
          ],
          signal,
        ),
      ),
    )
    .flat();
  if (!comments.some((comment) => comment.body.includes(marker))) {
    await gh(
      [
        "api",
        `repos/${repo}/issues/${issueNumber}/comments`,
        "-f",
        `body=${body}`,
      ],
      signal,
    );
  }
}

export const extension = {
  type: "@webframp/github-issue-lifecycle",
  resources: {
    published_review: {
      description:
        "A Nightshift adversarial-review comment published to GitHub",
      schema: z.object({
        issueNumber: z.number().int().positive(),
        phase: z.enum(["plan", "code"]),
        publicationKey: z.string(),
        findingCount: z.number().int().positive(),
        publishedAt: z.iso.datetime(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    published_plan: {
      description: "A Nightshift implementation plan published to GitHub",
      schema: z.object({
        issueNumber: z.number().int().positive(),
        publicationKey: z.string(),
        publishedAt: z.iso.datetime(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: [
    {
      publish_plan: {
        description: "Publish one idempotent Nightshift plan to an issue",
        arguments: PlanArguments,
        execute: async (args: PlanArguments, context: Context) => {
          const repo = z
            .string()
            .regex(/^[\w.-]+\/[\w.-]+$/)
            .parse(context.globalArgs.repo);
          const marker = `<!-- nightshift-plan:${args.publication_key} -->`;
          await publishComment(
            repo,
            args.issue_number,
            marker,
            planComment(args),
            context.signal,
          );
          const handle = await context.writeResource(
            "published_plan",
            `published-plan-${args.issue_number}`,
            {
              issueNumber: args.issue_number,
              publicationKey: args.publication_key,
              publishedAt: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
    {
      publish_review: {
        description:
          "Publish one idempotent Nightshift review round to an issue",
        arguments: Arguments,
        execute: async (args: Arguments, context: Context) => {
          const repo = z
            .string()
            .regex(/^[\w.-]+\/[\w.-]+$/)
            .parse(context.globalArgs.repo);
          const marker = `<!-- nightshift-review:${args.phase}:${args.publication_key} -->`;
          await publishComment(
            repo,
            args.issue_number,
            marker,
            reviewComment(args),
            context.signal,
          );
          const handle = await context.writeResource(
            "published_review",
            `published-review-${args.issue_number}-${args.phase}`,
            {
              issueNumber: args.issue_number,
              phase: args.phase,
              publicationKey: args.publication_key,
              findingCount: args.findings.length,
              publishedAt: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
