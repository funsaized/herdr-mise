import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

const version = readFileSync("install.sh", "utf8").match(
  /^HERDR_MISE_VERSION=(\S+)$/m,
)?.[1];

function fixture(system = "Darwin", machine = "arm64", options = {}) {
  const targets = {
    "Darwin-arm64": "aarch64-apple-darwin",
    "Darwin-x86_64": "x86_64-apple-darwin",
    "Linux-x86_64": "x86_64-unknown-linux-gnu",
  };
  const root = mkdtempSync(join(tmpdir(), "herdr-mise-installer-test-"));
  const release = join(root, "release");
  const stage = join(root, "archive");
  const fakeBin = join(root, "fake-bin");
  const target = targets[`${system}-${machine}`] ?? "unsupported";
  mkdirSync(release);
  mkdirSync(stage);
  mkdirSync(fakeBin);
  writeFileSync(join(stage, "herdr-mise"), "#!/bin/sh\necho installed\n");
  chmodSync(join(stage, "herdr-mise"), 0o755);
  writeFileSync(join(stage, "LICENSE"), "MIT\n");
  writeFileSync(join(stage, "THIRD_PARTY_NOTICES.txt"), "notices\n");
  if (options.extraFile) writeFileSync(join(stage, "unexpected"), "no\n");
  const archive = join(release, `herdr-mise-v${version}-${target}.tar.gz`);
  const files = ["herdr-mise", "LICENSE", "THIRD_PARTY_NOTICES.txt"];
  if (options.extraFile) files.push("unexpected");
  const packed = spawnSync("tar", ["-C", stage, "-czf", archive, ...files], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const digest = spawnSync("shasum", ["-a", "256", archive], {
    encoding: "utf8",
  }).stdout.split(/\s+/)[0];
  writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  writeFileSync(
    join(fakeBin, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo ${system};; -m) echo ${machine};; esac\n`,
  );
  chmodSync(join(fakeBin, "uname"), 0o755);
  for (const command of ["cargo", "npm", "node", "sudo"]) {
    writeFileSync(
      join(fakeBin, command),
      `#!/bin/sh\necho ${command} >>"${join(root, "forbidden-commands")}"\nexit 99\n`,
    );
    chmodSync(join(fakeBin, command), 0o755);
  }
  return { root, release, archive, fakeBin, target, digest };
}

function install(value, mode = "--plugin", overrides = {}) {
  const pluginRoot = join(value.root, "plugin-root");
  const home = join(value.root, "home");
  const temp = join(value.root, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const result = spawnSync("sh", ["install.sh", ...(mode ? [mode] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${value.fakeBin}:${process.env.PATH}`,
      HOME: home,
      TMPDIR: temp,
      HERDR_MISE_RELEASE_BASE_URL: `file://${value.release}`,
      HERDR_MISE_TEST_ALLOW_FILE_URLS: "1",
      HERDR_MISE_PLUGIN_ROOT: pluginRoot,
      HERDR_MISE_DATA_HOME: join(value.root, "data"),
      HERDR_MISE_BIN_DIR: join(value.root, "bin"),
      ...overrides,
    },
  });
  return { result, pluginRoot, home, temp };
}

for (const [system, machine, target] of [
  ["Darwin", "arm64", "aarch64-apple-darwin"],
  ["Darwin", "x86_64", "x86_64-apple-darwin"],
  ["Linux", "x86_64", "x86_64-unknown-linux-gnu"],
]) {
  test(`selects ${target}`, () => {
    const value = fixture(system, machine);
    const { result, pluginRoot } = install(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(
        join(pluginRoot, "herdr-mise", version, "bin", "herdr-mise"),
        "utf8",
      ),
      "#!/bin/sh\necho installed\n",
    );
  });
}

test("rejects unsupported systems before downloading", () => {
  const value = fixture("Linux", "aarch64");
  const { result } = install(value);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported platform/);
});

test("rejects musl Linux before downloading", () => {
  const value = fixture("Linux", "x86_64");
  writeFileSync(join(value.fakeBin, "ldd"), "#!/bin/sh\necho musl libc\n");
  chmodSync(join(value.fakeBin, "ldd"), 0o755);
  const { result } = install(value);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /musl/);
});

test("rejects HTTP artifact URLs", () => {
  const value = fixture();
  const { result } = install(value, "--plugin", {
    HERDR_MISE_RELEASE_BASE_URL: "http://example.test/releases",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTPS/);
});

test("rejects malformed checksums", () => {
  const value = fixture();
  writeFileSync(`${value.archive}.sha256`, `ABC  ${basename(value.archive)}\n`);
  const { result } = install(value);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /malformed checksum/);
});

test("rejects a sidecar naming another file", () => {
  const value = fixture();
  writeFileSync(`${value.archive}.sha256`, `${value.digest}  other.tar.gz\n`);
  const { result } = install(value);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wrong file/);
});

test("rejects a checksum mismatch", () => {
  const value = fixture();
  writeFileSync(
    `${value.archive}.sha256`,
    `${"0".repeat(64)}  ${basename(value.archive)}\n`,
  );
  const { result } = install(value);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
});

test("rejects unexpected archive contents", () => {
  const value = fixture("Darwin", "arm64", { extraFile: true });
  const { result } = install(value);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected archive contents/);
});

test("plugin mode switches current atomically without external writes or toolchains", () => {
  const value = fixture();
  const base = join(value.root, "plugin-root", "herdr-mise");
  mkdirSync(join(base, "old"), { recursive: true });
  spawnSync("ln", ["-s", "old", join(base, "current")]);
  const { result, home, temp } = install(value);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(join(base, "current")), version);
  assert.equal(lstatSync(join(base, "current")).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(home), []);
  assert.deepEqual(readdirSync(temp), []);
  assert.equal(existsSync(join(value.root, "forbidden-commands")), false);
  assert.equal(
    readdirSync(base).some((name) => name.includes(".tmp.")),
    false,
  );
});

test("standalone mode is idempotent and installs an atomic launcher", () => {
  const value = fixture();
  const first = install(value, "");
  assert.equal(first.result.status, 0, first.result.stderr);
  const second = install(value, "");
  assert.equal(second.result.status, 0, second.result.stderr);
  const launcher = join(value.root, "bin", "herdr-mise");
  assert.equal(lstatSync(launcher).isSymbolicLink(), true);
  assert.equal(
    readlinkSync(launcher),
    join(value.root, "data", "herdr-mise", "current", "bin", "herdr-mise"),
  );
  assert.match(second.result.stdout, new RegExp(`herdr-mise ${version}`));
});

test("plugin and standalone upgrades preserve the previous install on verification failure", () => {
  for (const mode of ["--plugin", ""]) {
    const value = fixture();
    const base = join(value.root, mode ? "plugin-root" : "data", "herdr-mise");
    const previous = join(base, "0.3.0", "bin", "herdr-mise");
    mkdirSync(join(base, "0.3.0", "bin"), { recursive: true });
    writeFileSync(previous, "#!/bin/sh\necho previous\n");
    chmodSync(previous, 0o755);
    symlinkSync("0.3.0", join(base, "current"));
    const launcher = join(value.root, "bin", "herdr-mise");
    const launcherTarget = join(base, "current", "bin", "herdr-mise");
    if (!mode) {
      mkdirSync(join(value.root, "bin"));
      symlinkSync(launcherTarget, launcher);
    }

    writeFileSync(
      `${value.archive}.sha256`,
      `${"0".repeat(64)}  ${basename(value.archive)}\n`,
    );
    const failed = install(value, mode);
    assert.notEqual(failed.result.status, 0);
    assert.match(failed.result.stderr, /checksum mismatch/);
    assert.deepEqual(readdirSync(base).sort(), ["0.3.0", "current"]);
    assert.equal(readlinkSync(join(base, "current")), "0.3.0");
    assert.equal(readFileSync(previous, "utf8"), "#!/bin/sh\necho previous\n");
    assert.equal(
      readFileSync(launcherTarget, "utf8"),
      "#!/bin/sh\necho previous\n",
    );
    if (!mode) assert.equal(readlinkSync(launcher), launcherTarget);
    assert.deepEqual(readdirSync(failed.temp), []);

    writeFileSync(
      `${value.archive}.sha256`,
      `${value.digest}  ${basename(value.archive)}\n`,
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const installed = install(value, mode);
      assert.equal(installed.result.status, 0, installed.result.stderr);
      assert.equal(readlinkSync(join(base, "current")), version);
      assert.deepEqual(readdirSync(base).sort(), ["0.3.0", version, "current"]);
      assert.equal(
        readFileSync(previous, "utf8"),
        "#!/bin/sh\necho previous\n",
      );
      assert.equal(
        readFileSync(launcherTarget, "utf8"),
        "#!/bin/sh\necho installed\n",
      );
      if (!mode) {
        assert.equal(readlinkSync(launcher), launcherTarget);
        assert.deepEqual(readdirSync(join(value.root, "bin")), ["herdr-mise"]);
      }
      assert.deepEqual(readdirSync(installed.temp), []);
      assert.equal(existsSync(join(value.root, "forbidden-commands")), false);
    }
  }
});

test("standalone mode refuses a non-symlink launcher", () => {
  const value = fixture();
  mkdirSync(join(value.root, "bin"));
  writeFileSync(join(value.root, "bin", "herdr-mise"), "keep\n");
  const { result } = install(value, "");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite/);
  assert.equal(
    readFileSync(join(value.root, "bin", "herdr-mise"), "utf8"),
    "keep\n",
  );
});

test("every download disables curl configuration", () => {
  const downloads = readFileSync("install.sh", "utf8")
    .split("\n")
    .filter((line) => line.startsWith("curl "));
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every((line) => line.startsWith("curl -q ")));
});
