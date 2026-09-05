/** Owner-operated delivery through the existing authenticated GitHub integration. */
import { z } from "npm:zod@4.4.3";

const repo = "funsaized/herdr-mise";
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Pr = z.number().int().positive();
type Context = {
  signal?: AbortSignal;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

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
  const result = await new Deno.Command("gh", {
    args,
    signal,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: { ...env, GH_PROMPT_DISABLED: "1" },
  }).output();
  if (!result.success)
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  return new TextDecoder().decode(result.stdout).trim();
}
async function record(context: Context, operation: string, result: unknown) {
  const handle = await context.writeResource("delivery", operation, {
    operation,
    observedAt: new Date().toISOString(),
    result,
  });
  return { dataHandles: [handle] };
}
async function view(prNumber: number, signal?: AbortSignal) {
  return JSON.parse(
    await gh(
      [
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "number,url,state,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup",
      ],
      signal,
    ),
  );
}
export function requireSubject(pr: Record<string, unknown>, headSha: string) {
  if (
    pr.state !== "OPEN" ||
    pr.isDraft !== false ||
    pr.baseRefName !== "main" ||
    pr.headRefOid !== headSha
  ) {
    throw new Error("Expected exact open, non-draft PR head against main");
  }
}
export const extension = {
  type: "@webframp/github",
  resources: {
    delivery: {
      description: "Owner-operated delivery observations and mutation receipts",
      schema: z.object({
        operation: z.string(),
        observedAt: z.iso.datetime(),
        result: z.unknown(),
      }),
      lifetime: "30d",
      garbageCollection: 100,
    },
  },
  methods: [
    {
      inspect_delivery: {
        description:
          "Read authenticated identity, PR checks, and recent managed runs",
        arguments: z.object({ prNumber: Pr.optional() }),
        execute: async (args: { prNumber?: number }, context: Context) =>
          record(context, "inspect", {
            actor: JSON.parse(
              await gh(
                ["api", "user", "--jq", "{login: .login}"],
                context.signal,
              ),
            ),
            pr: args.prNumber
              ? await view(args.prNumber, context.signal)
              : null,
            runs: JSON.parse(
              await gh(
                [
                  "run",
                  "list",
                  "--repo",
                  repo,
                  "--workflow",
                  "swamp-managed-verification.yml",
                  "--limit",
                  "10",
                  "--json",
                  "databaseId,status,conclusion,url,createdAt,headSha",
                ],
                context.signal,
              ),
            ),
          }),
      },
    },
    {
      open_delivery_pr: {
        description:
          "Open or reuse a same-repository backlog PR using existing gh authentication",
        arguments: z.object({
          head: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_-]+$/),
          title: z.string().min(1).max(256),
          body: z.string().max(65000),
        }),
        execute: async (
          args: { head: string; title: string; body: string },
          context: Context,
        ) => {
          const existing = JSON.parse(
            await gh(
              [
                "pr",
                "list",
                "--repo",
                repo,
                "--head",
                args.head,
                "--base",
                "main",
                "--state",
                "open",
                "--json",
                "number,url",
              ],
              context.signal,
            ),
          );
          const result = existing.length
            ? existing[0]
            : {
                url: await gh(
                  [
                    "pr",
                    "create",
                    "--repo",
                    repo,
                    "--base",
                    "main",
                    "--head",
                    args.head,
                    "--title",
                    args.title,
                    "--body",
                    args.body,
                  ],
                  context.signal,
                ),
              };
          return record(context, "open-pr", result);
        },
      },
    },
    {
      dispatch_managed: {
        description:
          "Owner-dispatch trusted main verification for an exact PR head",
        arguments: z.object({ prNumber: Pr, headSha: Sha }),
        execute: async (
          args: { prNumber: number; headSha: string },
          context: Context,
        ) => {
          const actor = await gh(
            ["api", "user", "--jq", ".login"],
            context.signal,
          );
          if (actor !== "funsaized")
            throw new Error("Trust-boundary dispatch requires funsaized");
          requireSubject(
            await view(args.prNumber, context.signal),
            args.headSha,
          );
          await gh(
            [
              "workflow",
              "run",
              "swamp-managed-verification.yml",
              "--repo",
              repo,
              "--ref",
              "main",
              "-f",
              `prNumber=${args.prNumber}`,
            ],
            context.signal,
          );
          return record(context, "dispatch", {
            ...args,
            actor,
            controlRef: "main",
            accepted: true,
          });
        },
      },
    },
    {
      merge_delivery: {
        description:
          "Squash an exact clean PR head without admin bypass or auto-merge",
        arguments: z.object({ prNumber: Pr, headSha: Sha }),
        execute: async (
          args: { prNumber: number; headSha: string },
          context: Context,
        ) => {
          const pr = await view(args.prNumber, context.signal);
          requireSubject(pr, args.headSha);
          if (
            pr.mergeStateStatus !== "CLEAN" ||
            pr.reviewDecision === "CHANGES_REQUESTED" ||
            pr.reviewDecision === "REVIEW_REQUIRED"
          )
            throw new Error("PR checks or required reviews are not ready");
          await gh(
            [
              "pr",
              "checks",
              String(args.prNumber),
              "--repo",
              repo,
              "--required",
            ],
            context.signal,
          );
          await gh(
            [
              "pr",
              "merge",
              String(args.prNumber),
              "--repo",
              repo,
              "--squash",
              "--match-head-commit",
              args.headSha,
            ],
            context.signal,
          );
          return record(
            context,
            "merge",
            await view(args.prNumber, context.signal),
          );
        },
      },
    },
  ],
};
