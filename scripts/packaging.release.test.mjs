import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const cargoVersion = readFileSync("server/Cargo.toml", "utf8").match(
  /^version = "([^"]+)"$/m,
)?.[1];

test("packaging fails when tar fails instead of emitting an empty gzip", () => {
  const temp = mkdtempSync(join(tmpdir(), "herdr-mise-tar-failure-"));
  const fakeTar = join(temp, "tar");
  const fakeBinary = join(temp, "herdr-mise");
  writeFileSync(
    fakeTar,
    '#!/bin/sh\n[ "${1:-}" = "--version" ] && { echo bsdtar; exit 0; }\nexit 42\n',
  );
  writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeTar, 0o755);
  chmodSync(fakeBinary, 0o755);

  try {
    const result = spawnSync(
      "sh",
      ["scripts/package-release.sh", "tar-failure-test", fakeBinary],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${temp}:${process.env.PATH}` },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 42, result.stderr || result.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(`dist/herdr-mise-v${cargoVersion}-tar-failure-test.tar.gz`, {
      force: true,
    });
    rmSync(`dist/herdr-mise-v${cargoVersion}-tar-failure-test.tar.gz.sha256`, {
      force: true,
    });
  }
});

test("release archives include the executable and required license notices", () => {
  const temp = mkdtempSync(join(tmpdir(), "herdr-mise-release-contents-"));
  const fakeBinary = join(temp, "herdr-mise");
  writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeBinary, 0o755);

  const archive = `dist/herdr-mise-v${cargoVersion}-notice-test.tar.gz`;
  const checksum = `${archive}.sha256`;
  try {
    const packaged = spawnSync(
      "sh",
      ["scripts/package-release.sh", "notice-test", fakeBinary],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
      },
    );
    assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
    const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.deepEqual(listed.stdout.trim().split("\n").sort(), [
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
      "herdr-mise",
    ]);
    const notices = spawnSync(
      "tar",
      ["-xOzf", archive, "THIRD_PARTY_NOTICES.txt"],
      {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    assert.equal(notices.status, 0, notices.stderr || notices.stdout);
    assert.match(notices.stdout, /Instrument Sans Project Authors/);
    assert.match(notices.stdout, /Silkscreen Project Authors/);
    assert.match(notices.stdout, /Rust dependencies/);
    assert.match(notices.stdout, /JavaScript dependencies/);
    assert.doesNotMatch(notices.stdout, /Rust dependency: jsonschema /);
    assert.doesNotMatch(notices.stdout, /No standalone license file/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(archive, { force: true });
    rmSync(checksum, { force: true });
  }
});
