import {
  cleanupWorkspace,
  prepareWorkspace,
  type WorkspaceArguments,
} from "../models/git_workspace.ts";

async function git(cwd: string, ...args: string[]) {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function expectFailure(run: () => Promise<unknown>, message: string) {
  try {
    await run();
  } catch {
    return;
  }
  throw new Error(message);
}

Deno.test("prepares and safely reuses a dirty isolated worktree", async () => {
  const root = await Deno.makeTempDir({ prefix: "nightshift-workspace-" });
  const remote = `${root}/remote.git`;
  const seed = `${root}/seed`;
  const control = `${root}/control`;
  try {
    await Deno.mkdir(seed);
    await git(root, "init", "--bare", "--quiet", remote);
    await git(seed, "init", "--quiet", "--initial-branch=main");
    await Deno.writeTextFile(`${seed}/value.txt`, "one\n");
    await Deno.writeTextFile(
      `${seed}/.gitignore`,
      "client/*.tsbuildinfo\n.swamp/\n",
    );
    await git(seed, "add", "value.txt", ".gitignore");
    await git(
      seed,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "initial",
    );
    await git(seed, "remote", "add", "origin", remote);
    await git(seed, "push", "--quiet", "origin", "main");
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    await git(root, "clone", "--quiet", remote, control);

    const args: WorkspaceArguments = {
      workItem: "67",
      repositoryUrl: remote,
      workspaceRoot: root,
      directoryName: "nightshift-67",
      baseRef: "main",
      branch: "nightshift/67",
    };
    const first = await prepareWorkspace(control, args);
    await expectFailure(
      () =>
        prepareWorkspace(control, {
          ...args,
          workItem: "control",
          directoryName: "control",
          branch: "nightshift/control",
        }),
      "workspace preparation accepted the control checkout",
    );
    await expectFailure(
      () =>
        cleanupWorkspace(control, {
          workItem: "control",
          subjectRoot: control,
        }),
      "workspace cleanup accepted the control checkout",
    );
    await Deno.mkdir(`${root}/nested`);
    await expectFailure(
      () =>
        cleanupWorkspace(control, {
          workItem: "outside",
          subjectRoot: `${root}/nested/missing`,
        }),
      "missing cleanup path bypassed the sibling boundary",
    );
    await Deno.writeTextFile(`${first.subjectRoot}/value.txt`, "changed\n");
    const other = await prepareWorkspace(control, {
      ...args,
      workItem: "68",
      directoryName: "nightshift-68",
      branch: "nightshift/68",
    });
    if (
      other.subjectRoot === first.subjectRoot ||
      (await git(other.subjectRoot, "branch", "--show-current")) !==
        "nightshift/68" ||
      (await git(other.subjectRoot, "status", "--porcelain"))
    ) {
      throw new Error("work item changes leaked into a sibling workspace");
    }
    const second = await prepareWorkspace(control, args);
    if (
      second.subjectRoot !== first.subjectRoot ||
      second.baseCommit !== first.baseCommit
    ) {
      throw new Error("workspace reuse changed identity");
    }
    if (!(await git(second.subjectRoot, "status", "--porcelain"))) {
      throw new Error("dirty workspace was overwritten");
    }
    if (await git(control, "status", "--porcelain")) {
      throw new Error("control checkout was changed");
    }
    await Deno.mkdir(`${second.subjectRoot}/target`);
    await Deno.writeTextFile(`${second.subjectRoot}/target/artifact`, "large");
    await Deno.mkdir(`${second.subjectRoot}/.swamp`);
    await Deno.writeTextFile(`${second.subjectRoot}/.swamp/audit`, "preserve");
    const preserved = await cleanupWorkspace(control, {
      workItem: "67",
      subjectRoot: second.subjectRoot,
    });
    if (
      !preserved.preserved ||
      preserved.removed ||
      (await Deno.lstat(`${second.subjectRoot}/target`).then(
        () => true,
        () => false,
      )) ||
      !(await Deno.lstat(`${second.subjectRoot}/.swamp/audit`).then(
        () => true,
        () => false,
      ))
    ) {
      throw new Error("dirty workspace cleanup was not safely bounded");
    }
    await git(second.subjectRoot, "checkout", "--", "value.txt");
    await Deno.mkdir(`${second.subjectRoot}/.opencode/node_modules`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${second.subjectRoot}/.opencode/.gitignore`,
      "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n",
    );
    await Deno.writeTextFile(
      `${second.subjectRoot}/.opencode/package.json`,
      "{}",
    );
    await Deno.writeTextFile(
      `${second.subjectRoot}/.opencode/package-lock.json`,
      "{}",
    );
    await Deno.writeTextFile(`${second.subjectRoot}/.opencode/bun.lock`, "");
    await Deno.mkdir(`${second.subjectRoot}/client`);
    await Deno.writeTextFile(
      `${second.subjectRoot}/client/tsconfig.app.tsbuildinfo`,
      "generated",
    );
    await Deno.writeTextFile(
      `${second.subjectRoot}/client/tsconfig.node.tsbuildinfo`,
      "generated",
    );
    const removed = await cleanupWorkspace(control, {
      workItem: "67",
      subjectRoot: second.subjectRoot,
    });
    if (
      !removed.removed ||
      removed.preserved ||
      !removed.removedPaths.includes(".opencode/.gitignore") ||
      !removed.removedPaths.includes(".opencode/bun.lock") ||
      !removed.removedPaths.includes(".opencode/node_modules") ||
      !removed.removedPaths.includes(".opencode/package-lock.json") ||
      !removed.removedPaths.includes(".opencode/package.json") ||
      !removed.removedPaths.includes(".swamp") ||
      !removed.removedPaths.includes("client/tsconfig.app.tsbuildinfo") ||
      !removed.removedPaths.includes("client/tsconfig.node.tsbuildinfo")
    ) {
      throw new Error(
        `clean workspace was not removed: ${JSON.stringify(removed)}`,
      );
    }
    const replayed = await cleanupWorkspace(control, {
      workItem: "67",
      subjectRoot: second.subjectRoot,
    });
    if (!replayed.removed || replayed.reason !== "already removed") {
      throw new Error("workspace cleanup is not idempotent");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
