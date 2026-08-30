import {
  cleanupWorkspace,
  prepareWorkspace,
  type WorkspaceArguments,
} from "../models/git_workspace.ts";

async function git(cwd: string, ...args: string[]) {
  const result = await new Deno.Command("git", {
    args,
    cwd,
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
    await git(seed, "add", "value.txt");
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
      ))
    ) {
      throw new Error("dirty workspace cleanup was not safely bounded");
    }
    await git(second.subjectRoot, "checkout", "--", "value.txt");
    const removed = await cleanupWorkspace(control, {
      workItem: "67",
      subjectRoot: second.subjectRoot,
    });
    if (!removed.removed || removed.preserved) {
      throw new Error("clean workspace was not removed");
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
