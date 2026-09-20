/** Owner-operated delivery through the existing authenticated GitHub integration. */
import { z } from "npm:zod@4.4.3";
import { validateManagedReceipt } from "./managed_receipt.ts";

const repo = "funsaized/herdr-mise";
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Pr = z.number().int().positive();
const Head = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_-]+$/);
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
      "PATH",
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
        "number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup",
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

export function compatibilityDispatchArgs(
  pr: Record<string, unknown>,
  headSha: string,
) {
  requireSubject(pr, headSha);
  return [
    "workflow",
    "run",
    "herdr-compatibility-drift.yml",
    "--repo",
    repo,
    "--ref",
    Head.parse(pr.headRefName),
  ];
}

export function requireManagedSuccess(checks: Array<Record<string, unknown>>) {
  if (
    !checks.some(
      (check) =>
        check.context === "Swamp managed verification" &&
        check.state === "SUCCESS",
    )
  ) {
    throw new Error(
      "Exact-head Swamp managed verification status is not successful",
    );
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
      require_managed_verification: {
        description:
          "Verify the trusted gate receipt for the exact current candidate without rerunning local verification",
        arguments: z.object({
          workItem: z.string().regex(/^[1-9][0-9]*$/),
          prUrl: z
            .string()
            .regex(
              /^https:\/\/github\.com\/funsaized\/herdr-mise\/pull\/[1-9][0-9]*$/,
            ),
          commit: Sha,
          baseCommit: Sha,
        }),
        execute: async (
          args: {
            workItem: string;
            prUrl: string;
            commit: string;
            baseCommit: string;
          },
          context: Context,
        ) => {
          const api = async (path: string) =>
            JSON.parse(
              await gh(["api", `repos/${repo}/${path}`], context.signal),
            );
          const prNumber = Number(args.prUrl.split("/").at(-1));
          const checkCurrent = async () => {
            const pr = await api(`pulls/${prNumber}`);
            const main = await api("branches/main");
            if (
              pr.state !== "open" ||
              pr.draft ||
              pr.head.sha !== args.commit ||
              pr.head.repo?.full_name !== repo ||
              pr.base.repo?.full_name !== repo ||
              pr.base.ref !== "main" ||
              pr.base.sha !== args.baseCommit ||
              main.commit.sha !== args.baseCommit
            )
              throw new Error(
                "Managed candidate is not the exact current PR head and main base",
              );
          };
          await checkCurrent();
          const statuses = await api(
            `commits/${args.commit}/statuses?per_page=100`,
          );
          const status = statuses.find(
            (entry: { context: string }) =>
              entry.context === "Swamp managed verification",
          );
          const match =
            typeof status?.target_url === "string"
              ? status.target_url.match(
                  /^https:\/\/github\.com\/funsaized\/herdr-mise\/actions\/runs\/([1-9][0-9]*)$/,
                )
              : null;
          if (status?.state !== "success" || !match)
            throw new Error(
              "Current candidate needs a successful trusted managed gate",
            );
          const gateRunId = match[1];
          const gate = await api(`actions/runs/${gateRunId}`);
          const workflow = await api(`actions/workflows/${gate.workflow_id}`);
          const artifacts = (
            await api(`actions/runs/${gateRunId}/artifacts?per_page=100`)
          ).artifacts.filter(
            (artifact: { name: string }) =>
              artifact.name === "swamp-managed-receipt",
          );
          if (
            artifacts.length !== 1 ||
            artifacts[0].expired ||
            artifacts[0].size_in_bytes > 262144
          )
            throw new Error(
              "Managed receipt artifact missing, ambiguous, expired or oversized",
            );
          // Reject untrusted workflows before downloading their output.
          if (
            workflow.path !== ".github/workflows/swamp-managed-gate.yml" ||
            gate.event !== "workflow_run" ||
            gate.head_sha !== args.baseCommit ||
            gate.conclusion !== "success"
          )
            throw new Error(
              "Status target is not the trusted current-main gate",
            );
          const temp = await Deno.makeTempDir({
            prefix: "nightshift-managed-receipt-",
          });
          try {
            await gh(
              [
                "run",
                "download",
                gateRunId,
                "--repo",
                repo,
                "--name",
                "swamp-managed-receipt",
                "--dir",
                temp,
              ],
              context.signal,
            );
            const path = `${temp}/receipt.json`;
            const info = await Deno.lstat(path);
            if (!info.isFile || info.isSymlink || info.size > 131072)
              throw new Error("Managed receipt is not a bounded regular file");
            const raw = JSON.parse(await Deno.readTextFile(path));
            if (!/^[1-9][0-9]*$/.test(String(raw.producerRunId)))
              throw new Error("Invalid producer run identity");
            const producer = await api(`actions/runs/${raw.producerRunId}`);
            const contents = async (path: string) => {
              const data = await api(`contents/${path}?ref=${args.baseCommit}`);
              if (data.encoding !== "base64")
                throw new Error("Expected bounded GitHub content");
              return Uint8Array.from(
                atob(data.content.replace(/\s/g, "")),
                (character) => character.charCodeAt(0),
              );
            };
            const digest = async (bytes: Uint8Array) =>
              [
                ...new Uint8Array(
                  await crypto.subtle.digest("SHA-256", bytes as BufferSource),
                ),
              ]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
            const policyBytes = await contents(
              "verification/managed-policy.json",
            );
            const policy = JSON.parse(new TextDecoder().decode(policyBytes));
            const receipt = validateManagedReceipt(
              raw,
              {
                prNumber,
                headSha: args.commit,
                baseSha: args.baseCommit,
                gateRunId,
                maxAgeHours: policy.maxAgeHours,
                policySha256: await digest(policyBytes),
                workflowSha256: await digest(
                  await contents("workflows/workflow-verification.yaml"),
                ),
              },
              gate,
              workflow,
              producer,
            );
            await checkCurrent();
            const currentStatuses = await api(
              `commits/${args.commit}/statuses?per_page=100`,
            );
            const currentStatus = currentStatuses.find(
              (entry: { context: string }) =>
                entry.context === "Swamp managed verification",
            );
            if (
              currentStatus?.id !== status.id ||
              currentStatus?.state !== "success"
            )
              throw new Error(
                "Managed status changed during receipt validation",
              );
            return record(
              context,
              `managed-${args.workItem}-${args.commit}`,
              receipt,
            );
          } finally {
            await Deno.remove(temp, { recursive: true });
          }
        },
      },
    },
    {
      inspect_delivery_run: {
        description:
          "Read one repository Actions run, its jobs and artifact metadata, with failed-step logs",
        arguments: z.object({ runId: Pr }),
        execute: async (args: { runId: number }, context: Context) => {
          const run = JSON.parse(
            await gh(
              [
                "run",
                "view",
                String(args.runId),
                "--repo",
                repo,
                "--json",
                "databaseId,url,status,conclusion,headSha,createdAt,updatedAt,jobs",
              ],
              context.signal,
            ),
          );
          const artifacts = JSON.parse(
            await gh(
              ["api", `repos/${repo}/actions/runs/${args.runId}/artifacts`],
              context.signal,
            ),
          );
          const failedLogs =
            run.conclusion === "failure"
              ? await gh(
                  [
                    "run",
                    "view",
                    String(args.runId),
                    "--repo",
                    repo,
                    "--log-failed",
                  ],
                  context.signal,
                )
              : null;
          return record(context, `run-${args.runId}`, {
            run,
            artifacts,
            failedLogs,
          });
        },
      },
    },
    {
      dispatch_compatibility: {
        description:
          "Dispatch the non-publishing compatibility and discovery check for an exact PR head",
        arguments: z.object({ prNumber: Pr, headSha: Sha }),
        execute: async (
          args: { prNumber: number; headSha: string },
          context: Context,
        ) => {
          const command = compatibilityDispatchArgs(
            await view(args.prNumber, context.signal),
            args.headSha,
          );
          await gh(command, context.signal);
          return record(context, "compatibility-dispatch", {
            ...args,
            headRef: command[6],
            accepted: true,
          });
        },
      },
    },
    {
      inspect_compatibility: {
        description: "Inspect the latest compatibility run for an exact commit",
        arguments: z.object({ headSha: Sha }),
        execute: async (args: { headSha: string }, context: Context) =>
          record(
            context,
            "compatibility-run",
            JSON.parse(
              await gh(
                [
                  "run",
                  "list",
                  "--repo",
                  repo,
                  "--workflow",
                  "herdr-compatibility-drift.yml",
                  "--commit",
                  args.headSha,
                  "--limit",
                  "1",
                  "--json",
                  "databaseId,status,conclusion,headSha,url,createdAt",
                ],
                context.signal,
              ),
            ),
          ),
      },
    },
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
          head: Head,
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
          requireManagedSuccess(pr.statusCheckRollup);
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
