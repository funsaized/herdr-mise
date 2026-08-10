import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const cargo = readFileSync('server/Cargo.toml', 'utf8');
const packager = readFileSync('scripts/package-release.sh', 'utf8');
const browserSmoke = readFileSync('scripts/smoke-browser.mjs', 'utf8');

test('release workflow keeps publication tag-only and covers every target', () => {
  assert.match(workflow, /push:\n    tags: \['v\*'\]/);
  assert.match(workflow, /publish:\n    if: startsWith\(github\.ref, 'refs\/tags\/'\)/);
  for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-gnu']) {
    assert.match(workflow, new RegExp(target));
  }
  assert.match(workflow, /os: macos-15\n            target: aarch64-apple-darwin/);
  assert.match(workflow, /os: macos-15-intel\n            target: x86_64-apple-darwin/);
  assert.doesNotMatch(workflow, /macos-13/);
  assert.match(workflow, /concurrency:\n  group: release-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false/);
});

test('release version has one authoritative prerelease value', () => {
  const version = cargo.match(/^version = "([^"]+)"$/m)?.[1];
  assert.ok(version, 'Cargo package version');
  assert.match(version, /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/);
  assert.ok(!workflow.includes(version), 'workflow must derive, not duplicate, the Cargo version');
  assert.ok(packager.includes('server/Cargo.toml'));
  assert.match(packager, /version=\$\(sed /);
  assert.match(workflow, /test "\$GITHUB_REF_NAME" = "v\$version"/);
});

test('packaging normalizes archive ownership with native GNU and BSD tar flags', () => {
  assert.match(packager, /tar --version .*grep -q 'GNU tar'/);
  assert.match(packager, /--owner=0 --group=0 --numeric-owner/);
  assert.match(packager, /--uid 0 --gid 0 --uname root --gname root/);
  assert.match(packager, /-cf "\$tarball" herdr-mise LICENSE THIRD_PARTY_NOTICES\.txt/);
  assert.match(packager, /gzip -n <"\$tarball"/);
  assert.doesNotMatch(packager, /tar .*\| gzip/);
});

test('packaging fails when tar fails instead of emitting an empty gzip', () => {
  const temp = mkdtempSync(join(tmpdir(), 'herdr-mise-tar-failure-'));
  const fakeTar = join(temp, 'tar');
  const fakeBinary = join(temp, 'herdr-mise');
  writeFileSync(fakeTar, '#!/bin/sh\n[ "${1:-}" = "--version" ] && { echo bsdtar; exit 0; }\nexit 42\n');
  writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeTar, 0o755);
  chmodSync(fakeBinary, 0o755);

  try {
    const result = spawnSync('sh', ['scripts/package-release.sh', 'tar-failure-test', fakeBinary], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${temp}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 42, result.stderr || result.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync('dist/herdr-mise-v0.1.0-rc.1-tar-failure-test.tar.gz', { force: true });
    rmSync('dist/herdr-mise-v0.1.0-rc.1-tar-failure-test.tar.gz.sha256', { force: true });
  }
});

test('release archives include the executable and required license notices', () => {
  const temp = mkdtempSync(join(tmpdir(), 'herdr-mise-release-contents-'));
  const fakeBinary = join(temp, 'herdr-mise');
  writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeBinary, 0o755);

  const archive = 'dist/herdr-mise-v0.1.0-rc.1-notice-test.tar.gz';
  const checksum = `${archive}.sha256`;
  try {
    const packaged = spawnSync('sh', ['scripts/package-release.sh', 'notice-test', fakeBinary], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
    const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.deepEqual(listed.stdout.trim().split('\n').sort(), [
      'LICENSE',
      'THIRD_PARTY_NOTICES.txt',
      'herdr-mise',
    ]);
    const notices = spawnSync('tar', ['-xOzf', archive, 'THIRD_PARTY_NOTICES.txt'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
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

test('packaged browser smoke proves bundled fonts load', () => {
  assert.match(browserSmoke, /document\.fonts\.load\('16px "Instrument Sans"'\)/);
  assert.match(browserSmoke, /document\.fonts\.load\('16px Silkscreen'\)/);
});

test('tagged macOS builds sign, notarize, and clean ephemeral credentials', () => {
  for (const token of ['codesign --force --options runtime --timestamp', 'notarytool submit', 'spctl --assess --type exec', 'security delete-keychain']) {
    assert.ok(workflow.includes(token), token);
  }
  assert.match(workflow, /security delete-keychain "\$RUNNER_TEMP\/release-signing\.keychain-db"/);
  assert.match(workflow, /VERIFY_GATEKEEPER=1/);
});

test('existing expected asset subsets are rerunnable but unexpected assets fail closed', () => {
  assert.match(workflow, /comm -23 existing-assets\.txt expected-assets\.txt >unexpected-assets\.txt/);
  assert.match(workflow, /test ! -s unexpected-assets\.txt/);
  assert.match(workflow, /gh release upload .* --clobber/);
  assert.match(workflow, /diff -u expected-assets\.txt published-assets\.txt/);
});
