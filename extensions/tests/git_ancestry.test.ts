import { isAncestor } from "../models/git_ancestry.ts";

async function git(repoDir: string, ...args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    cwd: repoDir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("recognizes only forward commit ancestry", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    await git(repoDir, "init", "--quiet");
    await Deno.writeTextFile(`${repoDir}/value.txt`, "one\n");
    await git(repoDir, "add", "value.txt");
    await git(
      repoDir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "first",
    );
    const first = await git(repoDir, "rev-parse", "HEAD");

    await Deno.writeTextFile(`${repoDir}/value.txt`, "two\n");
    await git(repoDir, "add", "value.txt");
    await git(
      repoDir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "second",
    );
    const second = await git(repoDir, "rev-parse", "HEAD");

    if (!(await isAncestor(repoDir, first, second))) {
      throw new Error("first commit should be an ancestor of second");
    }
    if (!(await isAncestor(repoDir, second, second))) {
      throw new Error("a commit should be its own ancestor");
    }
    if (await isAncestor(repoDir, second, first)) {
      throw new Error("second commit should not be an ancestor of first");
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});
