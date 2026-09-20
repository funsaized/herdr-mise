import {
  assertProtectedLauncher,
  macosProfile,
  probeMacosSandbox,
} from "../models/nightshift_agent.ts";

Deno.test("an actor cannot use a launcher in shared writable sandbox storage", () => {
  assertProtectedLauncher("/Users/example/projects/control", "/Users/example");
  for (const path of [
    "/private/tmp/control",
    "/Users/example/.cache/control",
  ]) {
    let rejected = false;
    try {
      assertProtectedLauncher(path, "/Users/example");
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`Writable launcher accepted: ${path}`);
  }
});

Deno.test({
  name: "macOS role profiles enforce native source and credential canaries",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const evidence = await probeMacosSandbox(Deno.cwd());
    if (!evidence.passed) throw new Error(JSON.stringify(evidence));
  },
});

Deno.test("sandbox policy rejects a symlink supplied as a profile", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/agent-constraints`);
    await Deno.writeTextFile(`${root}/policy`, "untrusted");
    await Deno.symlink(
      `${root}/policy`,
      `${root}/agent-constraints/nightshift-actor.sb`,
    );
    let rejected = false;
    try {
      await macosProfile(root, "actor");
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Symlink policy accepted");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
