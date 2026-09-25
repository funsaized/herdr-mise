import {
  assertProtectedLauncher,
  macosProfile,
  macosLauncher,
  probeMacosSandbox,
  extension,
} from "../models/nightshift_agent.ts";

Deno.test("retired item 77 is rejected before any agent is installed or launched", async () => {
  let message = "";
  try {
    await extension.methods[0].invoke_nightshift.execute(
      {
        prompt: "should never launch",
        invocationId: "retired-77",
        opencodeAgent: "plan",
        tags: { factory: "nightshift", workItem: "77" },
      },
      {
        repoDir: "/no-agent-here",
        globalArgs: {
          defaultProvider: "opencode",
          defaultToolProfile: "readonly",
        },
        writeResource: async () => {
          throw new Error("unexpected write");
        },
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message !== "Nightshift item 77 is retired") {
    throw new Error(
      `retired agent launched or failed for another reason: ${message}`,
    );
  }
});

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

Deno.test("provider launcher rejects a symlink into actor-writable storage", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/scripts`);
    await Deno.writeTextFile(`${root}/untrusted.py`, "print('untrusted')");
    await Deno.symlink(
      `${root}/untrusted.py`,
      `${root}/scripts/nightshift-opencode.py`,
    );
    let rejected = false;
    try {
      await macosLauncher(root);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Symlink launcher accepted");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
