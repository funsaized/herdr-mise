/** Adds read-only commit ancestry validation to @swamp/git. */
import { resolve } from "node:path";
import { z } from "npm:zod@4.4.3";
import { subjectRoot } from "./subject_root.ts";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Arguments = z.object({
  ancestor: Sha,
  descendant: Sha,
});
const SubjectArguments = Arguments.extend({
  subjectRoot: z.string().min(1),
});

type Context = {
  repoDir: string;
  globalArgs: { repoPath?: string };
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

export async function isAncestor(
  repoDir: string,
  ancestor: string,
  descendant: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await new Deno.Command("git", {
    args: ["merge-base", "--is-ancestor", ancestor, descendant],
    cwd: repoDir,
    stdout: "null",
    stderr: "piped",
    signal,
  }).output();
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(
    new TextDecoder().decode(result.stderr).trim() ||
      "git merge-base --is-ancestor failed",
  );
}

export const extension = {
  type: "@swamp/git",
  resources: {
    ancestryResult: {
      description: "Result of a Git commit ancestry assertion",
      schema: z.object({
        ancestor: Sha,
        descendant: Sha,
        isAncestor: z.literal(true),
      }),
      lifetime: "ephemeral",
      garbageCollection: 20,
    },
    subjectResult: {
      description: "Exact source and base identity for a verification subject",
      schema: z.object({
        commit: Sha,
        tree: Sha,
        baseCommit: Sha,
        clean: z.literal(true),
        startedAt: z.iso.datetime(),
        completedAt: z.iso.datetime(),
        durationMs: z.number().int().nonnegative(),
      }),
      lifetime: "ephemeral",
      garbageCollection: 20,
    },
  },
  methods: [
    {
      require_ancestor: {
        description: "Require one Git commit to be an ancestor of another",
        arguments: Arguments,
        execute: async (args: z.infer<typeof Arguments>, context: Context) => {
          const repoDir = resolve(
            context.repoDir,
            context.globalArgs.repoPath ?? ".",
          );
          if (
            !(await isAncestor(
              repoDir,
              args.ancestor,
              args.descendant,
              context.signal,
            ))
          ) {
            throw new Error(
              `${args.descendant} does not contain ${args.ancestor}; sync the branch with current main before verification`,
            );
          }
          const handle = await context.writeResource(
            "ancestryResult",
            "ancestry",
            {
              ...args,
              isAncestor: true,
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
    {
      subject_preflight: {
        description:
          "Require an exact clean subject commit containing the supplied base",
        arguments: SubjectArguments,
        execute: async (
          args: z.infer<typeof SubjectArguments>,
          context: Context,
        ) => {
          const started = Date.now();
          const root = await subjectRoot(context.repoDir, args.subjectRoot);
          const run = async (commandArgs: string[]) => {
            const result = await new Deno.Command("git", {
              args: commandArgs,
              cwd: root,
              stdout: "piped",
              stderr: "piped",
              signal: context.signal,
              env: {
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_NOSYSTEM: "1",
              },
            }).output();
            if (!result.success) {
              throw new Error(
                new TextDecoder().decode(result.stderr).trim() ||
                  `git ${commandArgs[0]} failed`,
              );
            }
            return new TextDecoder().decode(result.stdout).trim();
          };
          const commit = await run(["rev-parse", "HEAD"]);
          if (commit !== args.descendant) {
            throw new Error(
              `expected HEAD ${args.descendant}, found ${commit}`,
            );
          }
          const status = await run(["status", "--porcelain"]);
          if (status) throw new Error("verification subject must be clean");
          if (
            !(await isAncestor(
              root,
              args.ancestor,
              args.descendant,
              context.signal,
            ))
          ) {
            throw new Error(
              `${args.descendant} does not contain ${args.ancestor}`,
            );
          }
          const tree = await run(["rev-parse", "HEAD^{tree}"]);
          const completedAt = new Date().toISOString();
          const handle = await context.writeResource(
            "subjectResult",
            "subject",
            {
              commit,
              tree,
              baseCommit: args.ancestor,
              clean: true,
              startedAt: new Date(started).toISOString(),
              completedAt,
              durationMs: Date.now() - started,
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
