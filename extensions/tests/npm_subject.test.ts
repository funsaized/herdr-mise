import { subjectEnvironment } from "../models/npm_subject.ts";

Deno.test("isolated npm subjects retain the original default Deno location", () => {
  const env = subjectEnvironment(
    "/tmp/isolated",
    { HOME: "/operator", PATH: "/bin", SECRET: "private" },
    {},
  );
  if (env.DENO_EXEC_PATH !== "/operator/.swamp/deno/deno") {
    throw new Error("isolating HOME lost the installed Deno runtime");
  }
  if (env.HOME !== "/tmp/isolated" || "SECRET" in env) {
    throw new Error("runtime discovery weakened environment isolation");
  }
});

Deno.test("managed and configured Deno locations survive npm isolation", () => {
  const inherited = { HOME: "/operator", DENO_EXEC_PATH: "/managed/deno" };
  if (
    subjectEnvironment("/tmp/isolated", inherited, {}).DENO_EXEC_PATH !==
    "/managed/deno"
  ) {
    throw new Error("managed runtime override was lost");
  }
  if (
    subjectEnvironment("/tmp/isolated", inherited, {
      DENO_EXEC_PATH: "/configured/deno",
      HOME: "/unsafe",
    }).DENO_EXEC_PATH !== "/configured/deno"
  ) {
    throw new Error("configured runtime override was lost");
  }
  if (
    subjectEnvironment("/tmp/isolated", inherited, { HOME: "/unsafe" }).HOME !==
    "/tmp/isolated"
  ) {
    throw new Error("configured environment escaped HOME isolation");
  }
});

import { extension } from "../models/npm_subject.ts";

Deno.test("npm subject failures persist evidence, finalize once and preserve the primary error", async () => {
  const run = extension.methods[1].run_subject!.execute;
  for (const brokenLog of [false, true]) {
    let finalized = 0;
    let evidence: Record<string, unknown> | undefined;
    const primaryPath = "/nonexistent/factory-subject";
    let thrown: unknown;
    try {
      await run(
        {
          subjectRoot: primaryPath,
          expectedGitHead: "a".repeat(40),
          script: "test",
          args: [],
        },
        {
          repoDir: primaryPath,
          globalArgs: {
            projectDir: ".",
            lifecycleScripts: "deny",
            allowedScripts: ["test"],
            environment: {},
            defaultTimeoutMs: 1000,
            requireCleanGit: true,
          },
          createFileWriter: () => ({
            writeLine: async () => {
              if (brokenLog) throw new Error("log write fault");
            },
            finalize: async () => {
              finalized++;
              if (brokenLog) throw new Error("log finalize fault");
              return { name: "log" };
            },
          }),
          writeResource: async (_spec, name, data) => {
            evidence = data;
            return { name };
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error) || !thrown.message.includes(primaryPath))
      throw new Error("primary preflight error was replaced");
    if (
      finalized !== 1 ||
      evidence?.executionStatus !== "failed" ||
      evidence?.exitCode !== null
    )
      throw new Error("preflight did not finalize truthful failure evidence");
    if (brokenLog && !String(evidence.error).includes("log finalize fault"))
      throw new Error("secondary diagnostic was lost");
  }
});

Deno.test("npm subjects clean temporary HOME on HEAD failure and reap children on log failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "npm-subject-test-" });
  const git = async (...args: string[]) => {
    const result = await new Deno.Command("git", {
      args,
      cwd: root,
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success)
      throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  const makeTempDir = Deno.makeTempDir;
  const created: string[] = [];
  try {
    await Deno.writeTextFile(
      `${root}/package.json`,
      JSON.stringify({ scripts: { test: "node -e \"console.log('probe')\"" } }),
    );
    await Deno.writeTextFile(`${root}/package-lock.json`, "{}");
    await git("init", "--quiet");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    const head = await git("rev-parse", "HEAD");
    // Each Deno test module owns its globals; restore before the next test.
    Deno.makeTempDir = async (options) => {
      const path = await makeTempDir(options);
      created.push(path);
      return path;
    };
    for (const mode of ["head", "log", "success"]) {
      let finalized = 0;
      let evidence: Record<string, unknown> | undefined;
      let thrown: unknown;
      try {
        await extension.methods[1].run_subject!.execute(
          {
            subjectRoot: ".",
            expectedGitHead: mode === "head" ? "a".repeat(40) : head,
            script: "test",
            args: [],
          },
          {
            repoDir: root,
            globalArgs: {
              projectDir: ".",
              lifecycleScripts: "deny",
              allowedScripts: ["test"],
              environment: {},
              defaultTimeoutMs: 5000,
              requireCleanGit: true,
            },
            createFileWriter: () => ({
              writeLine: async (line) => {
                if (mode === "log" && line.startsWith("[stdout]"))
                  throw new Error("stream log fault");
              },
              finalize: async () => {
                finalized++;
                return { name: "log" };
              },
            }),
            writeResource: async (_spec, name, data) => {
              evidence = data;
              return { name };
            },
          },
        );
      } catch (error) {
        thrown = error;
      }
      if (
        mode === "success" ? thrown !== undefined : !(thrown instanceof Error)
      )
        throw new Error(`unexpected ${mode} outcome: ${thrown}`);
      if (
        mode === "log" &&
        !(thrown as Error).message.includes("stream log fault")
      )
        throw new Error("stream error replaced by cancellation");
      if (
        finalized !== 1 ||
        evidence?.executionStatus !==
          (mode === "success" ? "succeeded" : "failed")
      )
        throw new Error("incorrect finalized evidence");
      for (const path of created) {
        try {
          await Deno.stat(path);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        throw new Error(`temporary HOME leaked: ${path}`);
      }
    }
  } finally {
    Deno.makeTempDir = makeTempDir;
    await Deno.remove(root, { recursive: true });
    for (const path of created)
      await Deno.remove(path, { recursive: true }).catch(() => {});
  }
});
