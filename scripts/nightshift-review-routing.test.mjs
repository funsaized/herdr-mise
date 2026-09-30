import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { routeLanes } from "../extensions/models/nightshift_review_routing.mjs";

test("UI rework routes all four lanes after a prior UI pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-routing-"));
  const path = "server/tests/goldens/scene-blocked.txt";
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  try {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(new URL(`../${path}`, import.meta.url), join(root, path));
    const fixture = await readFile(join(root, path), "utf8");
    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "fixture",
    );
    const base = git("rev-parse", "HEAD");
    for (const rework of [1, 2]) {
      await writeFile(join(root, path), `${fixture}\nRework ${rework}\n`);
      const files = git("diff", "--name-only", "-z", base, "--")
        .split("\0")
        .filter(Boolean);
      assert.deepEqual(files, [path]);
      assert.deepEqual(
        routeLanes("code", files, [
          { id: "LANE:ui", description: "pass: clean" },
        ]),
        {
          lanes: ["test-coverage", "security", "quality", "ui"],
          reason: "UI paths changed",
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
