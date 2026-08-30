/** Adds idempotent per-work-item worktree preparation to @swamp/git. */
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "jsr:@std/path@1.1.2";
import { z } from "npm:zod@4.4.3";
import { assertSubjectRootLocation, subjectRoot } from "./subject_root.ts";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const WorkspaceName = z
  .string()
  .regex(/^(?![.-])(?!.*[.-]$)[A-Za-z0-9._-]{1,64}$/);
const Arguments = z.object({
  workItem: WorkspaceName,
  directoryName: WorkspaceName.optional(),
  repositoryUrl: z.string().min(1).max(2048),
  workspaceRoot: z.string().min(1),
  baseRef: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("-")),
  branch: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("-")),
});
const CleanupArguments = z.object({
  workItem: WorkspaceName,
  subjectRoot: z.string().min(1),
});

const GENERATED_PATHS = [
  "target",
  "target-linux-x64",
  "node_modules",
  "client/node_modules",
  "client/dist",
  "client/dist-visual",
  "dist",
  "perf/artifacts",
  "e2e/artifacts",
] as const;

export type WorkspaceArguments = z.infer<typeof Arguments>;
export type CleanupWorkspaceArguments = z.infer<typeof CleanupArguments>;

type Context = {
  repoDir: string;
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  allowFailure = false,
) {
  const result = await new Deno.Command("git", {
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    cwd,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  const stdout = new TextDecoder().decode(result.stdout).trim();
  if (!result.success && !allowFailure) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() || `git ${args[0]} failed`,
    );
  }
  return { success: result.success, stdout };
}

function repositoryIdentity(value: string) {
  const scp = value.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2]}`.replace(/\.git\/?$/, "");
  try {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}${url.pathname}`.replace(
      /\.git\/?$/,
      "",
    );
  } catch {
    return resolve(value).replace(/\.git\/?$/, "");
  }
}

function worktrees(output: string) {
  const entries: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      entries.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return entries;
}

async function baseCommit(
  subjectRoot: string,
  fetched: string,
  signal?: AbortSignal,
) {
  const head = (await git(subjectRoot, ["rev-parse", "HEAD^{commit}"], signal))
    .stdout;
  const containsFetched = await git(
    subjectRoot,
    ["merge-base", "--is-ancestor", fetched, head],
    signal,
    true,
  );
  if (containsFetched.success) return fetched;
  const mergeBase = await git(
    subjectRoot,
    ["merge-base", head, fetched],
    signal,
  );
  return Sha.parse(mergeBase.stdout);
}

export async function prepareWorkspace(
  controlRoot: string,
  rawArgs: WorkspaceArguments,
  signal?: AbortSignal,
) {
  const args = Arguments.parse(rawArgs);
  const control = await Deno.realPath(controlRoot);
  const origin = (await git(control, ["remote", "get-url", "origin"], signal))
    .stdout;
  if (repositoryIdentity(origin) !== repositoryIdentity(args.repositoryUrl)) {
    throw new Error(
      `control checkout origin '${origin}' does not match '${args.repositoryUrl}'`,
    );
  }
  if (
    !(
      await git(
        control,
        ["check-ref-format", "--branch", args.branch],
        signal,
        true,
      )
    ).success
  ) {
    throw new Error(`invalid workspace branch: ${args.branch}`);
  }

  const unresolvedRoot = resolve(control, args.workspaceRoot);
  await Deno.mkdir(unresolvedRoot, { recursive: true });
  const rootInfo = await Deno.lstat(unresolvedRoot);
  if (!rootInfo.isDirectory || rootInfo.isSymlink) {
    throw new Error("workspaceRoot must be a regular directory");
  }
  const root = await Deno.realPath(unresolvedRoot);
  const subject = resolve(root, args.directoryName ?? args.workItem);
  if (relative(root, subject).startsWith(`..${SEPARATOR}`)) {
    throw new Error("workItem escapes workspaceRoot");
  }
  assertSubjectRootLocation(control, subject);
  if (subject === control) {
    throw new Error("workspace must not replace the control checkout");
  }

  await git(control, ["fetch", "--no-tags", "origin", args.baseRef], signal);
  const fetched = Sha.parse(
    (await git(control, ["rev-parse", "FETCH_HEAD^{commit}"], signal)).stdout,
  );
  const listed = worktrees(
    (await git(control, ["worktree", "list", "--porcelain"], signal)).stdout,
  );
  const exists = await Deno.lstat(subject).then(
    () => true,
    (error) => {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    },
  );

  if (exists) {
    const info = await Deno.lstat(subject);
    if (!info.isDirectory || info.isSymlink) {
      throw new Error("workspace path must be a regular directory");
    }
    const canonicalSubject = await Deno.realPath(subject);
    const registered = listed.find(
      (entry) => resolve(entry.path) === canonicalSubject,
    );
    if (!registered) {
      throw new Error("workspace path exists but is not a registered worktree");
    }
    const common = await Deno.realPath(
      (
        await git(
          canonicalSubject,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          signal,
        )
      ).stdout,
    );
    const controlCommon = await Deno.realPath(
      (
        await git(
          control,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          signal,
        )
      ).stdout,
    );
    if (common !== controlCommon) {
      throw new Error("workspace belongs to a different repository");
    }
    const branch = (
      await git(canonicalSubject, ["branch", "--show-current"], signal)
    ).stdout;
    if (branch !== args.branch) {
      throw new Error(
        `workspace branch '${branch || "detached"}' does not match '${args.branch}'`,
      );
    }
    // Expected dirty worktrees are reused without switching or resetting them.
    return {
      workItem: args.workItem,
      subjectRoot: canonicalSubject,
      branch,
      baseCommit: await baseCommit(canonicalSubject, fetched, signal),
    };
  }

  const branchRef = `refs/heads/${args.branch}`;
  const occupied = listed.find((entry) => entry.branch === branchRef);
  if (occupied) {
    throw new Error(
      `branch '${args.branch}' is already checked out at ${occupied.path}`,
    );
  }
  const branchExists = await git(
    control,
    ["show-ref", "--verify", "--quiet", branchRef],
    signal,
    true,
  );
  await git(
    control,
    branchExists.success
      ? ["worktree", "add", subject, args.branch]
      : ["worktree", "add", "-b", args.branch, subject, fetched],
    signal,
  );
  const canonicalSubject = await Deno.realPath(subject);
  return {
    workItem: args.workItem,
    subjectRoot: canonicalSubject,
    branch: args.branch,
    baseCommit: branchExists.success
      ? await baseCommit(canonicalSubject, fetched, signal)
      : fetched,
  };
}

export async function cleanupWorkspace(
  controlRoot: string,
  rawArgs: CleanupWorkspaceArguments,
  signal?: AbortSignal,
) {
  const args = CleanupArguments.parse(rawArgs);
  const control = await Deno.realPath(controlRoot);
  const unresolvedCandidate = resolve(control, args.subjectRoot);
  const candidate = join(
    await Deno.realPath(dirname(unresolvedCandidate)),
    basename(unresolvedCandidate),
  );
  assertSubjectRootLocation(control, candidate);
  if (candidate === control) {
    throw new Error("cleanup must not target the control checkout");
  }
  const exists = await Deno.lstat(candidate).then(
    () => true,
    (error) => {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    },
  );
  if (!exists) {
    return {
      workItem: args.workItem,
      subjectRoot: candidate,
      removed: true,
      preserved: false,
      reason: "already removed",
      removedPaths: [],
    };
  }

  const subject = await subjectRoot(control, candidate);
  const listed = worktrees(
    (await git(control, ["worktree", "list", "--porcelain"], signal)).stdout,
  );
  if (!listed.some((entry) => resolve(entry.path) === subject)) {
    throw new Error("workspace path exists but is not a registered worktree");
  }
  const common = await Deno.realPath(
    (
      await git(
        subject,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        signal,
      )
    ).stdout,
  );
  const controlCommon = await Deno.realPath(
    (
      await git(
        control,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        signal,
      )
    ).stdout,
  );
  if (common !== controlCommon) {
    throw new Error("workspace belongs to a different repository");
  }

  const sourceStatus = (
    await git(
      subject,
      ["status", "--porcelain", "--untracked-files=all"],
      signal,
    )
  ).stdout;
  const removedPaths: string[] = [];
  for (const path of GENERATED_PATHS) {
    const target = resolve(subject, path);
    const found = await Deno.lstat(target).then(
      () => true,
      (error) => {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      },
    );
    if (!found) continue;
    await Deno.remove(target, { recursive: true });
    removedPaths.push(path);
  }
  if (sourceStatus) {
    return {
      workItem: args.workItem,
      subjectRoot: subject,
      removed: false,
      preserved: true,
      reason: "workspace has uncommitted source changes",
      removedPaths,
    };
  }

  const ignoredStatus = (
    await git(subject, ["status", "--porcelain", "--ignored"], signal)
  ).stdout;
  if (ignoredStatus) {
    return {
      workItem: args.workItem,
      subjectRoot: subject,
      removed: false,
      preserved: true,
      reason: "workspace has unrecognized ignored files",
      removedPaths,
    };
  }
  await git(control, ["worktree", "remove", subject], signal);
  return {
    workItem: args.workItem,
    subjectRoot: subject,
    removed: true,
    preserved: false,
    reason: "clean workspace removed",
    removedPaths,
  };
}

export const extension = {
  type: "@swamp/git",
  resources: {
    workspaceResult: {
      description: "An isolated worktree prepared for one work item",
      schema: z.object({
        workItem: z.string(),
        subjectRoot: z.string().startsWith("/"),
        branch: z.string(),
        baseCommit: Sha,
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    cleanupResult: {
      description: "Safe cleanup result for one isolated work-item worktree",
      schema: z.object({
        workItem: z.string(),
        subjectRoot: z.string().startsWith("/"),
        removed: z.boolean(),
        preserved: z.boolean(),
        reason: z.string(),
        removedPaths: z.array(z.string()),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: [
    {
      prepare_workspace: {
        description: "Create or safely reuse one isolated work-item worktree",
        arguments: Arguments,
        execute: async (args: WorkspaceArguments, context: Context) => {
          const workspace = await prepareWorkspace(
            context.repoDir,
            args,
            context.signal,
          );
          const handle = await context.writeResource(
            "workspaceResult",
            `workspace-${args.workItem}`,
            workspace,
          );
          return { dataHandles: [handle] };
        },
      },
    },
    {
      cleanup_workspace: {
        description:
          "Remove generated artifacts and a clean registered worktree, preserving dirty source",
        arguments: CleanupArguments,
        execute: async (args: CleanupWorkspaceArguments, context: Context) => {
          const cleanup = await cleanupWorkspace(
            context.repoDir,
            args,
            context.signal,
          );
          const handle = await context.writeResource(
            "cleanupResult",
            `cleanup-${args.workItem}`,
            cleanup,
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
