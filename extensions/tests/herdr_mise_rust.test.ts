import {
  assertPublicLockedDependencies,
  previewCanary,
  previewCanaryFailure,
  previewProbeScript,
  previewSandboxArgs,
} from "../models/herdr_mise_rust.ts";
import {
  readRegularFile,
  sha256 as sha256Bytes,
} from "../models/verification_evidence.ts";

const bytes = (value = "") => new TextEncoder().encode(value);
const hasBwrap = (Deno.env.get("PATH") ?? "").split(":").some((path) => {
  try {
    return Deno.statSync(`${path}/bwrap`).isFile;
  } catch {
    return false;
  }
});
const success = (stdout = "") =>
  ({
    success: true,
    code: 0,
    signal: null,
    stdout: bytes(stdout),
    stderr: bytes(),
  }) as Deno.CommandOutput;

Deno.test("preview canary requires isolated namespaces and read-only inputs", async () => {
  const cargo = await Deno.makeTempDir();
  await Deno.mkdir(`${cargo}/registry`);
  const args = previewSandboxArgs("/source", cargo, "/rust", "/scratch");
  for (const required of [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--uid",
    "--gid",
    "--unshare-pid",
    "--unshare-net",
    "--cap-drop",
    "--proc",
    "--ro-bind",
  ]) {
    if (!args.includes(required)) throw new Error(`missing ${required}`);
  }
  if (args.includes("/repo") || args.includes(Deno.env.get("HOME") ?? "~"))
    throw new Error("sandbox exposes the repository or host home");
  const capDrop = args.indexOf("--cap-drop");
  if (args[capDrop + 1] !== "ALL")
    throw new Error("sandbox must drop all capabilities");
  if (
    args[args.indexOf("--uid") + 1] !== String(Deno.uid()) ||
    args[args.indexOf("--gid") + 1] !== String(Deno.gid())
  )
    throw new Error("sandbox must preserve the invoking user identity");
  const acquisition = previewSandboxArgs(
    "/source",
    cargo,
    "/rust",
    "/scratch",
    { allowNetwork: true },
  );
  if (acquisition.includes("--unshare-net"))
    throw new Error(
      "dependency acquisition must use the runner network unchanged",
    );
  const registry = args.indexOf(`${cargo}/registry`);
  if (registry < 1 || args[registry - 1] !== "--ro-bind")
    throw new Error("sandbox dependency cache is not read-only");
  await Deno.remove(cargo, { recursive: true });
});

Deno.test({
  name: "preview canary proves real bwrap filesystem and network isolation",
  ignore: Deno.build.os !== "linux" || !hasBwrap,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "preview-bwrap-test-" });
    const source = `${root}/source`;
    const cargo = `${root}/cargo`;
    const rust = `${root}/rust`;
    const work = `${root}/work`;
    try {
      await Promise.all(
        [source, cargo, rust, work].map((path) =>
          Deno.mkdir(path, { recursive: true }),
        ),
      );
      await Deno.writeTextFile(`${source}/Cargo.toml`, "[workspace]\n");
      await Deno.writeTextFile(`${work}/canary.sh`, previewProbeScript);
      await Deno.writeTextFile(`${root}/credential-sentinel`, "secret");
      await Deno.writeTextFile(`${root}/filesystem-sentinel`, "private");
      const result = await new Deno.Command("bwrap", {
        args: [
          ...previewSandboxArgs(source, cargo, rust, work),
          "--clearenv",
          "--setenv",
          "PATH",
          "/usr/bin:/bin",
          "--setenv",
          "CREDENTIAL_SENTINEL",
          `${root}/credential-sentinel`,
          "--setenv",
          "FILESYSTEM_SENTINEL",
          `${root}/filesystem-sentinel`,
          "/bin/sh",
          "/work/canary.sh",
        ],
        cwd: source,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!result.success)
        throw new Error(new TextDecoder().decode(result.stderr));
      for (const marker of [
        "credentials-hidden",
        "filesystem-sentinel-hidden",
        "dns-denied",
        "https-denied",
        "private-network-denied",
        "metadata-denied",
      ]) {
        const info = await Deno.stat(`${work}/${marker}`);
        if (!info.isFile || info.uid !== Deno.uid())
          throw new Error(`real bwrap probe did not produce ${marker}`);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("preview canary preserves bounded failure diagnostics", () => {
  const diagnostic = previewCanaryFailure(
    "sandboxed offline build",
    new Error("boom /private/source/file"),
    ["/private/source"],
  );
  if (
    diagnostic !== "sandboxed offline build failed: boom <redacted-path>/file"
  )
    throw new Error("failure diagnostic was not preserved and sanitized");
});

Deno.test("preview canary accepts only canonical Cargo.lock sources", () => {
  const canonical =
    'source = "registry+https://github.com/rust-lang/crates.io-index"';
  for (const lockfile of [
    canonical,
    'version = 3\n\n[[package]]\nname = "local"\nversion = "1.0.0"\n',
    `# source = "ignored"\n${canonical}\n`,
  ])
    assertPublicLockedDependencies(lockfile);

  for (const line of [
    'source = "git+https://example.invalid/dependency"',
    'source = "registry+https://example.invalid/index"',
    "source = 'registry+https://github.com/rust-lang/crates.io-index'",
    "source = 'git+https://example.invalid/dependency'",
    "source = registry+https://github.com/rust-lang/crates.io-index",
    'source = "unterminated',
    ` source = "registry+https://github.com/rust-lang/crates.io-index"`,
    'source="registry+https://github.com/rust-lang/crates.io-index"',
    `${canonical} # comment`,
    `${canonical} junk`,
    `"source" = "registry+https://github.com/rust-lang/crates.io-index"`,
    `'source' = "registry+https://github.com/rust-lang/crates.io-index"`,
    'source.value = "registry+https://github.com/rust-lang/crates.io-index"',
    'package.source = "registry+https://github.com/rust-lang/crates.io-index"',
    'package = { source = "registry+https://github.com/rust-lang/crates.io-index" }',
  ]) {
    try {
      assertPublicLockedDependencies(line);
      throw new Error(`unsupported source syntax was accepted: ${line}`);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Cargo.lock contains an unsupported dependency source"
      )
        throw error;
    }
  }
});

const previewTag = "preview-2026-09-06-abcdef123456";
const previewCommit = "a".repeat(40);
const canonicalLock =
  'version = 3\n\n[[package]]\nname = "example"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';

function previewGit(options: Deno.CommandOptions) {
  const args = options.args ?? [];
  if (args.includes("get-url"))
    return success("https://github.com/herdrdev/herdr.git\n");
  if (args.includes("status")) return success();
  if (args.includes("HEAD^{tree}")) return success(`${"b".repeat(40)}\n`);
  return success(`${previewCommit}\n`);
}

async function runPreviewFixture(
  prepareLock: (source: string, parent: string) => Promise<void>,
  afterBuild?: (source: string, parent: string) => Promise<void>,
) {
  const parent = await Deno.makeTempDir({ prefix: "preview-lock-test-" });
  const control = `${parent}/control`;
  const source = `${parent}/source`;
  const resources: Record<string, unknown>[] = [];
  const commands: string[][] = [];
  await Promise.all([Deno.mkdir(control), Deno.mkdir(source)]);
  await Deno.writeTextFile(`${source}/Cargo.toml`, "[workspace]\n");
  await prepareLock(source, parent);
  try {
    await previewCanary(
      {
        sourceRoot: "../source",
        expectedCommit: previewCommit,
        expectedTag: previewTag,
      },
      {
        globalArgs: {},
        repoDir: control,
        writeResource: (_spec, _name, data) => {
          resources.push(data);
          return Promise.resolve({ name: "preview-canary-result" });
        },
        runCommand: async (executable, options) => {
          const args = [...(options.args ?? [])];
          commands.push([executable, ...args]);
          if (executable === "git") return previewGit(options);
          if (executable === "rustc") return success(`${parent}/rust\n`);
          if (executable !== "bwrap")
            throw new Error(`${executable} ran outside bwrap`);
          if (args.includes("/work/canary.sh")) {
            // Simulated lifecycle markers are not real sandbox evidence; the Linux-only test above is.
            const mount = args.findIndex(
              (value, index) =>
                value === "/work" && args[index - 2] === "--bind",
            );
            if (mount < 0) throw new Error("sandbox work mount is missing");
            for (const marker of [
              "credentials-hidden",
              "filesystem-sentinel-hidden",
              "dns-denied",
              "https-denied",
              "private-network-denied",
              "metadata-denied",
            ])
              await Deno.writeTextFile(`${args[mount - 1]}/${marker}`, "stub");
          }
          if (args.some((arg) => arg.includes("cargo build")) && afterBuild)
            await afterBuild(source, parent);
          return success();
        },
      },
    );
  } catch {
    // The persisted result is the assertion boundary for expected failures.
  }
  return {
    result: resources.at(-1),
    commands,
    cleanup: () => Deno.remove(parent, { recursive: true }),
  };
}

Deno.test("readRegularFile rejects Cargo.lock filesystem escapes", async () => {
  const parent = await Deno.makeTempDir({ prefix: "regular-lock-test-" });
  const root = `${parent}/source`;
  const outside = `${parent}/outside`;
  const siblingPrefix = `${parent}/source-escape`;
  try {
    await Promise.all([
      Deno.mkdir(root),
      Deno.mkdir(outside),
      Deno.mkdir(siblingPrefix),
    ]);
    await Deno.writeTextFile(`${root}/Cargo.lock`, "regular");
    const regular = await readRegularFile(root, "Cargo.lock");
    if (
      (await sha256Bytes(regular)) !==
      "667937c3e7a68ea374716edae34173e66dc54f380cffaccceaf15dfbfad22f99"
    )
      throw new Error("regular Cargo.lock digest changed");

    await Deno.writeTextFile(`${outside}/sentinel`, "outside secret");
    await Deno.writeTextFile(`${root}/inside`, "inside");
    await Deno.writeTextFile(`${siblingPrefix}/sentinel`, "prefix secret");
    for (const [name, target] of [
      ["absolute-link", `${outside}/sentinel`],
      ["relative-link", "../outside/sentinel"],
      ["in-root-link", "inside"],
    ]) {
      await Deno.symlink(target, `${root}/${name}`);
    }
    await Deno.mkdir(`${root}/directory`);
    for (const path of [
      "absolute-link",
      "relative-link",
      "in-root-link",
      "missing",
      "directory",
      "../source-escape/sentinel",
      `${outside}/sentinel`,
    ]) {
      try {
        await readRegularFile(root, path);
        throw new Error(`unsafe path was accepted: ${path}`);
      } catch (error) {
        if (String(error).includes("outside secret"))
          throw new Error("outside sentinel content was exposed");
      }
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("preview canary rejects unsafe and noncanonical initial Cargo.lock files", async () => {
  const rejected = [
    'source = "git+https://example.invalid/secret-dependency"\n',
    "source = 'registry+https://github.com/rust-lang/crates.io-index'\n",
    `"source" = "registry+https://github.com/rust-lang/crates.io-index"\n`,
  ];
  for (const lockfile of rejected) {
    const fixture = await runPreviewFixture((source) =>
      Deno.writeTextFile(`${source}/Cargo.lock`, lockfile),
    );
    try {
      if (
        fixture.result?.status !== "failed" ||
        fixture.result.cargoLockSha256 !== undefined ||
        fixture.result.cleanupCompleted !== true ||
        fixture.commands.some(([command]) => command !== "git") ||
        String(fixture.result.error).includes("example.invalid")
      )
        throw new Error("source policy failure crossed the persisted boundary");
    } finally {
      await fixture.cleanup();
    }
  }

  const unsafeLocks = [
    async (source: string, parent: string) => {
      await Deno.writeTextFile(
        `${parent}/outside-lock`,
        "outside sentinel secret",
      );
      await Deno.symlink(`${parent}/outside-lock`, `${source}/Cargo.lock`);
    },
    async (source: string, parent: string) => {
      await Deno.writeTextFile(
        `${parent}/outside-lock`,
        "outside sentinel secret",
      );
      await Deno.symlink("../outside-lock", `${source}/Cargo.lock`);
    },
    async (source: string) => {
      await Deno.writeTextFile(`${source}/inside-lock`, "inside sentinel");
      await Deno.symlink("inside-lock", `${source}/Cargo.lock`);
    },
    async () => Promise.resolve(),
    async (source: string) => await Deno.mkdir(`${source}/Cargo.lock`),
  ];
  for (const prepare of unsafeLocks) {
    const fixture = await runPreviewFixture(prepare);
    try {
      if (
        fixture.result?.status !== "failed" ||
        fixture.result.cargoLockSha256 !== undefined ||
        fixture.result.cleanupCompleted !== true ||
        fixture.commands.some(([command]) => command !== "git") ||
        String(fixture.result.error).includes("sentinel")
      )
        throw new Error("unsafe initial lockfile was not contained");
    } finally {
      await fixture.cleanup();
    }
  }
});

Deno.test("preview canary attributes final Cargo.lock integrity failures", async () => {
  const originalDigest = await sha256Bytes(
    new TextEncoder().encode(canonicalLock),
  );
  const replacements = [
    async (source: string, parent: string) => {
      await Deno.remove(`${source}/Cargo.lock`);
      await Deno.writeTextFile(
        `${parent}/outside-lock`,
        "outside final secret",
      );
      await Deno.symlink(`${parent}/outside-lock`, `${source}/Cargo.lock`);
    },
    async (source: string) => await Deno.remove(`${source}/Cargo.lock`),
    async (source: string) => {
      await Deno.remove(`${source}/Cargo.lock`);
      await Deno.mkdir(`${source}/Cargo.lock`);
    },
    async (source: string) =>
      await Deno.writeTextFile(
        `${source}/Cargo.lock`,
        `${canonicalLock}# changed\n`,
      ),
  ];
  for (const replace of replacements) {
    const fixture = await runPreviewFixture(
      (source) => Deno.writeTextFile(`${source}/Cargo.lock`, canonicalLock),
      replace,
    );
    try {
      const error = String(fixture.result?.error);
      if (
        fixture.result?.status !== "failed" ||
        fixture.result.build !== "passed" ||
        fixture.result.cargoLockSha256 !== originalDigest ||
        fixture.result.cleanupCompleted !== true ||
        !error.startsWith("final Cargo.lock integrity verification failed:") ||
        !(fixture.result.transcript as string[]).includes(error) ||
        error.includes("outside final secret")
      )
        throw new Error("final lockfile failure was misattributed");
    } finally {
      await fixture.cleanup();
    }
  }

  const unchanged = await runPreviewFixture((source) =>
    Deno.writeTextFile(`${source}/Cargo.lock`, canonicalLock),
  );
  try {
    if (
      unchanged.result?.status !== "passed" ||
      unchanged.result.build !== "passed" ||
      unchanged.result.cargoLockSha256 !== originalDigest ||
      unchanged.result.cleanupCompleted !== true
    )
      throw new Error("unchanged lockfile did not pass");
  } finally {
    await unchanged.cleanup();
  }
});

Deno.test("preview canary consumes the workflow sibling checkout and records failures", async () => {
  const parent = await Deno.makeTempDir({
    prefix: "preview-canary-integration-",
  });
  const control = `${parent}/control`;
  const source = `${parent}/herdr-preview-source`;
  const sysroot = `${parent}/rust`;
  const tag = "preview-2026-09-06-abcdef123456";
  const commands: string[][] = [];
  const resources: Record<string, unknown>[] = [];
  const git = async (args: string[]) => {
    const result = await new Deno.Command("git", {
      args,
      cwd: source,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success)
      throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    await Promise.all([
      Deno.mkdir(control),
      Deno.mkdir(source),
      Deno.mkdir(`${sysroot}/bin`, { recursive: true }),
    ]);
    await git(["init", "--quiet"]);
    await git(["config", "user.name", "Example"]);
    await git(["config", "user.email", "example@example.com"]);
    await Deno.writeTextFile(
      `${source}/Cargo.toml`,
      '[package]\nname = "herdr"\nversion = "0.0.0"\n',
    );
    await Deno.writeTextFile(
      `${source}/Cargo.lock`,
      'version = 3\n\n[[package]]\nname = "example"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "0000000000000000000000000000000000000000000000000000000000000000"\n',
    );
    await git(["add", "Cargo.toml", "Cargo.lock"]);
    await git(["commit", "--quiet", "-m", "fixture"]);
    await git(["tag", tag]);
    await git([
      "remote",
      "add",
      "origin",
      "https://github.com/herdrdev/herdr.git",
    ]);
    const commit = await git(["rev-parse", "HEAD"]);
    const workflow = await Deno.readTextFile(
      new URL(
        "../../workflows/workflow-herdr-release-discovery.yaml",
        import.meta.url,
      ),
    );
    const sourceRoot = workflow.match(/\n\s+path:\s*(\S+)/)?.[1];
    if (!sourceRoot) throw new Error("workflow clone path is missing");

    try {
      await previewCanary(
        { sourceRoot, expectedCommit: commit, expectedTag: tag },
        {
          globalArgs: {},
          repoDir: control,
          writeResource: (_spec, _name, data) => {
            resources.push(data);
            return Promise.resolve({ name: "preview-canary-result" });
          },
          runCommand: async (executable, options) => {
            commands.push([executable, ...(options.args ?? [])]);
            if (executable === "git")
              return await new Deno.Command(executable, options).output();
            if (executable === "rustc") return success(`${sysroot}\n`);
            if (executable !== "bwrap")
              throw new Error(`${executable} ran outside bwrap`);
            return (options.args ?? []).includes("fetch")
              ? {
                  ...success(),
                  success: false,
                  code: 101,
                  stderr: bytes("fixture compiler diagnostic"),
                }
              : success();
          },
        },
      );
      throw new Error("sandboxed dependency failure unexpectedly passed");
    } catch {
      const resource = resources.at(-1);
      if (
        resource?.status !== "failed" ||
        resource.sourceClean !== true ||
        !String(resource.error).includes("fixture compiler diagnostic")
      )
        throw new Error("sandbox failure diagnostics were not recorded");
    }
    const fetch = commands.find((command) => command.includes("fetch"));
    if (!fetch || fetch[0] !== "bwrap")
      throw new Error("dependency acquisition bypassed bwrap");
    try {
      await previewCanary(
        { sourceRoot, expectedCommit: "0".repeat(40), expectedTag: tag },
        {
          globalArgs: {},
          repoDir: control,
          writeResource: (_spec, _name, data) => {
            resources.push(data);
            return Promise.resolve({ name: "preview-canary-result" });
          },
        },
      );
      throw new Error("identity mismatch unexpectedly passed");
    } catch {
      const resource = resources.at(-1);
      if (
        resource?.status !== "failed" ||
        resource.sourceClean !== false ||
        !String(resource.error).startsWith(
          "source identity verification failed:",
        )
      )
        throw new Error("identity failure did not persist a structured result");
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
