import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function makeArtifact(root, version) {
  const stage = join(root, `stage-${version}`);
  mkdirSync(stage);
  writeFileSync(join(stage, "herdr-mise"), `#!/bin/sh\necho ${version}\n`);
  chmodSync(join(stage, "herdr-mise"), 0o755);
  writeFileSync(join(stage, "LICENSE"), "test license\n");
  writeFileSync(
    join(stage, "THIRD_PARTY_NOTICES.txt"),
    "## Rust dependencies\n## JavaScript dependencies\nInstrument Sans Project Authors\nSilkscreen Project Authors\n",
  );
  const archive = join(root, `herdr-mise-v${version}-test.tar.gz`);
  assert.equal(
    spawnSync("tar", [
      "-C",
      stage,
      "-czf",
      archive,
      "herdr-mise",
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
    ]).status,
    0,
  );
  const digest = spawnSync("shasum", ["-a", "256", archive], {
    encoding: "utf8",
  }).stdout.split(/\s+/)[0];
  const checksum = `${archive}.sha256`;
  writeFileSync(checksum, `${digest}  ${basename(archive)}\n`);
  return { archive, checksum, digest };
}

function installArtifact(root, installRoot, version) {
  const { archive, checksum, digest } = makeArtifact(root, version);
  const result = spawnSync(
    "sh",
    [
      "scripts/verify-public-artifact.sh",
      `file://${archive}`,
      `file://${checksum}`,
      version,
      installRoot,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ACCEPTANCE_ALLOW_FILE_URLS: "1",
        ACCEPTANCE_SKIP_SMOKE: "1",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return digest;
}

test("rejects non-HTTPS public URLs before download", () => {
  const result = spawnSync(
    "sh",
    [
      "scripts/verify-public-artifact.sh",
      "http://example.test/a.tar.gz",
      "http://example.test/a.tar.gz.sha256",
      "0.1.0-rc.1",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTPS/);
});

test("downloads, verifies, and installs into an exact versioned path", () => {
  const root = mkdtempSync(join(tmpdir(), "mise-public-test-"));
  const installRoot = join(root, "install");
  const digest = installArtifact(root, installRoot, "0.1.0-rc.1");
  assert.equal(
    readFileSync(
      join(installRoot, "herdr-mise", "0.1.0-rc.1", "bin", "herdr-mise"),
      "utf8",
    ),
    "#!/bin/sh\necho 0.1.0-rc.1\n",
  );
  assert.equal(
    readlinkSync(join(installRoot, "herdr-mise", "current")),
    "0.1.0-rc.1",
  );
  assert.equal(
    readFileSync(
      join(installRoot, "herdr-mise", "0.1.0-rc.1", "artifact-sha256"),
      "utf8",
    ).trim(),
    digest,
  );
});

test("second install switches current without leaving current.next litter", () => {
  const root = mkdtempSync(join(tmpdir(), "mise-upgrade-test-"));
  const installRoot = join(root, "install");
  installArtifact(root, installRoot, "0.1.0-rc.1");
  installArtifact(root, installRoot, "0.1.0-rc.2");
  const base = join(installRoot, "herdr-mise");
  assert.equal(readlinkSync(join(base, "current")), "0.1.0-rc.2");
  assert.throws(() => lstatSync(join(base, "current.next")), {
    code: "ENOENT",
  });
});

test("uninstall refuses current and removes only an unselected verified version", () => {
  const root = mkdtempSync(join(tmpdir(), "mise-uninstall-test-"));
  const base = join(root, "herdr-mise");
  for (const version of ["0.1.0-rc.1", "0.1.0-rc.2"]) {
    const directory = join(base, version);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "artifact-sha256"), "a".repeat(64));
    writeFileSync(
      join(directory, "public-source-url"),
      "https://example.test/a.tar.gz\n",
    );
  }
  assert.equal(
    spawnSync("ln", ["-s", "0.1.0-rc.2", join(base, "current")]).status,
    0,
  );
  const refused = spawnSync(
    "sh",
    ["scripts/uninstall-acceptance-artifact.sh", root, "0.1.0-rc.2"],
    { encoding: "utf8" },
  );
  assert.notEqual(refused.status, 0);
  const removed = spawnSync(
    "sh",
    ["scripts/uninstall-acceptance-artifact.sh", root, "0.1.0-rc.1"],
    { encoding: "utf8" },
  );
  assert.equal(removed.status, 0, removed.stderr);
});

for (const reserved of ["current", ".", ".."]) {
  test(`uninstall rejects reserved version name ${reserved}`, () => {
    const root = mkdtempSync(join(tmpdir(), "mise-uninstall-reserved-"));
    const base = join(root, "herdr-mise");
    const version = join(base, "0.1.0-rc.1");
    mkdirSync(version, { recursive: true });
    writeFileSync(join(version, "artifact-sha256"), "a".repeat(64));
    writeFileSync(
      join(version, "public-source-url"),
      "https://example.test/a.tar.gz\n",
    );
    assert.equal(
      spawnSync("ln", ["-s", "0.1.0-rc.1", join(base, "current")]).status,
      0,
    );
    const result = spawnSync(
      "sh",
      ["scripts/uninstall-acceptance-artifact.sh", root, reserved],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid|reserved|symlink/);
  });
}

test("curl disables default curlrc before every option", () => {
  const source = readFileSync("scripts/verify-public-artifact.sh", "utf8");
  const downloads = source
    .split("\n")
    .filter((line) => line.startsWith("curl "));
  assert.ok(downloads.length >= 2);
  assert.ok(downloads.every((line) => line.startsWith("curl -q ")));
});

test("soak rejects a relative state directory inside the repository", () => {
  const result = spawnSync(
    "sh",
    ["scripts/acceptance-soak.sh", "status", "relative-soak-state"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the source tree/);
});
