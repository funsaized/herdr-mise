import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyReleaseTag, validateReleaseTag } from "./release-policy.mjs";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const cargo = readFileSync("server/Cargo.toml", "utf8");
const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
const packager = readFileSync("scripts/package-release.sh", "utf8");
const releaseValidator = readFileSync("scripts/validate-release.sh", "utf8");
const artifactVerifier = readFileSync(
  "scripts/verify-release-artifact.sh",
  "utf8",
);
const browserSmoke = readFileSync("scripts/smoke-browser.mjs", "utf8");
const readme = readFileSync("README.md", "utf8");
const operations = readFileSync("docs/operations.md", "utf8");
const releasing = readFileSync("docs/releasing.md", "utf8");

const publishBlocks = [
  ...workflow.matchAll(
    /^      - name: Create or validate matching release class\n(?:(?!      - |  verify-public-release:)[\s\S])*?        run: \|\n((?:          .*\n)+)/gm,
  ),
];
assert.equal(publishBlocks.length, 1, "exactly one literal publish run block");
const publishShell = publishBlocks[0][1].replace(/^          /gm, "");
const targets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
];

// Only the GitHub transport is substituted; release-policy, shell tools, and artifact bytes are real.
const ghTransport = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.GH_TEST_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
const fail = (message) => { console.error(message); process.exit(1); };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'release') {
  if (args[1] === 'view') {
    if (!state.release) fail('release not found');
    process.stdout.write(JSON.stringify(state.release));
  } else if (args[1] === 'create') {
    if (state.release || !args.includes('--draft') || !args.includes('--verify-tag')) fail('invalid create');
    const tag = args[2];
    state.release = { databaseId: state.createdIdentity ?? 12345, tagName: tag, name: tag,
      isPrerelease: args.includes('--prerelease'),
      body: args.includes('--notes-file') ? fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8') : '' };
    state.events.push('create');
  } else if (args[1] === 'edit') {
    if (!state.release || !args.includes('--draft=false') || state.assets.length !== 6) fail('invalid publication');
    state.published = true;
    state.events.push('publish');
  } else fail('unsupported release command');
} else if (args[0] === 'api') {
  const endpoint = args.find(arg => arg.startsWith('repos/') || arg.startsWith('https://'));
  const base = 'repos/' + process.env.GITHUB_REPOSITORY + '/releases/';
  if (!endpoint || endpoint.includes('/tags/')) fail('draft-invisible tag asset lookup');
  if (endpoint === base + state.release?.databaseId + '/assets') {
    if (!args.includes('--paginate') || !args.includes('--jq') ||
        args[args.indexOf('--jq') + 1] !== '.[] | [.id, .name] | @tsv') fail('list must paginate identities');
    state.events.push('list');
    // Emit a second page too: the real gh --paginate applies --jq to each page.
    for (const page of [state.assets.slice(0, 2), state.assets.slice(2)]) {
      for (const asset of page) process.stdout.write(asset.id + '\\t' + asset.name + '\\n');
    }
  } else if (endpoint?.startsWith(base + 'assets/')) {
    if (!args.includes('Accept: application/octet-stream')) fail('missing binary Accept');
    const asset = state.assets.find(a => String(a.id) === endpoint.slice((base + 'assets/').length));
    if (!asset) fail('unknown asset id');
    state.events.push('compare:' + asset.name);
    save();
    process.stdout.write(Buffer.from(asset.bytes, 'base64'));
    process.exit(0);
  } else if (endpoint?.startsWith('https://uploads.github.com/' + base + state.release?.databaseId + '/assets?name=')) {
    if (!args.includes('--method') || args[args.indexOf('--method') + 1] !== 'POST' ||
        !args.includes('Content-Type: application/octet-stream') || !args.includes('--input')) fail('invalid binary upload');
    if (state.failUpload) fail('upload failed');
    const name = endpoint.split('?name=')[1];
    if (state.assets.some(a => a.name === name)) fail('overwrite forbidden');
    const bytes = fs.readFileSync(args[args.indexOf('--input') + 1]).toString('base64');
    state.assets.push({ id: 1000 + state.assets.length, name, bytes });
    state.events.push('upload:' + name);
  } else fail('unsupported endpoint: ' + endpoint);
} else fail('unsupported gh invocation');
save();
`;

function publishFixture(options = {}) {
  for (const cmd of ["bash", "jq", "perl", "sort", "comm", "cmp"]) {
    const check = spawnSync("bash", [
      "-c",
      cmd === "bash"
        ? 'test "${BASH_VERSINFO[0]}" -ge 4'
        : 'command -v "$1" >/dev/null',
      "bash",
      cmd,
    ]);
    assert.equal(
      check.status,
      0,
      `${cmd} is required for the release shell regression`,
    );
  }
  const temp = mkdtempSync(join(tmpdir(), "herdr-mise-publish-"));
  const tag = options.prerelease ? "v0.2.0-rc.1" : "v0.2.0";
  const root = join(temp, "checkout");
  const bin = join(temp, "bin");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "server"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "docs/releases"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(
    "scripts/release-policy.mjs",
    join(root, "scripts/release-policy.mjs"),
  );
  copyFileSync(
    "docs/releases/v0.2.0.md",
    join(root, "docs/releases/v0.2.0.md"),
  );
  writeFileSync(
    join(root, "server/Cargo.toml"),
    `[package]\nversion = "${tag.slice(1)}"\n`,
  );
  const assets = {};
  for (const target of targets) {
    const name = `herdr-mise-${tag}-${target}.tar.gz`;
    const bytes = Buffer.from(`archive bytes for ${name}\n`);
    assets[name] = bytes;
    assets[`${name}.sha256`] = Buffer.from(
      `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`,
    );
  }
  for (const [name, bytes] of Object.entries(assets))
    writeFileSync(join(root, "dist", name), bytes);
  const statePath = join(temp, "state.json");
  const release = options.existing
    ? {
        databaseId: options.identity ?? 12345,
        tagName: tag,
        name: tag,
        isPrerelease: !!options.prerelease,
        body: options.body ?? "",
        ...options.metadata,
      }
    : null;
  const state = {
    release,
    published: false,
    failUpload: !!options.failUpload,
    createdIdentity: options.createdIdentity,
    events: [],
    assets: (options.existingAssets ?? []).map((name, index) => ({
      id: 1000 + index,
      name,
      bytes: (
        options.assetBytes?.[name] ??
        assets[name] ??
        Buffer.from("unexpected")
      ).toString("base64"),
    })),
  };
  writeFileSync(statePath, JSON.stringify(state));
  const gh = join(bin, "gh");
  writeFileSync(gh, ghTransport);
  chmodSync(gh, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_TEST_STATE: statePath,
    GITHUB_REF_NAME: tag,
    GITHUB_REPOSITORY: "funsaized/herdr-mise",
    RELEASE_CLASS: options.prerelease ? "prerelease" : "stable",
    RUNNER_TEMP: temp,
  };
  for (const key of Object.keys(env))
    if (
      /^(GH_|GITHUB_.*(?:TOKEN|KEY|SECRET|PASSWORD)$|GITHUB_API_URL$)/.test(
        key,
      ) &&
      key !== "GH_TEST_STATE"
    )
      delete env[key];
  return {
    root,
    temp,
    assets,
    run() {
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", publishShell],
        { cwd: root, env, encoding: "utf8" },
      );
      return { ...result, state: JSON.parse(readFileSync(statePath, "utf8")) };
    },
    cleanup() {
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

test("release runbook retains tag, signing, and retirement safeguards", () => {
  assert.match(releasing, /narrow self-reference exception/);
  assert.match(releasing, /RC release deletion, RC\s+remote-tag deletion/);
  assert.match(releasing, /APPLE_CERTIFICATE_P12_BASE64/);
  assert.match(releasing, /git tag -a "\$TAG"/);
  assert.match(releasing, /There is no stapling target/);
});

test("strict release tags distinguish prereleases from stable releases", () => {
  assert.deepEqual(classifyReleaseTag("v0.1.0-rc.1"), {
    tag: "v0.1.0-rc.1",
    version: "0.1.0-rc.1",
    releaseClass: "prerelease",
    isPrerelease: true,
  });
  assert.deepEqual(classifyReleaseTag("v0.1.0"), {
    tag: "v0.1.0",
    version: "0.1.0",
    releaseClass: "stable",
    isPrerelease: false,
  });
});

test("release tags require canonical SemVer with a v prefix and no build metadata", () => {
  for (const invalid of [
    "0.1.0",
    "v01.1.0",
    "v0.01.0",
    "v0.1.00",
    "v0.1",
    "v0.1.0-rc.01",
    "v0.1.0-",
    "v0.1.0+build.1",
    "v0.1.0-rc.1+build.1",
    "v0.1.0/rc.1",
  ]) {
    assert.throws(() => classifyReleaseTag(invalid), /invalid release tag/i);
  }
});

test("release tags must exactly match the authoritative Cargo version", () => {
  assert.deepEqual(validateReleaseTag("v0.1.0-rc.1", "0.1.0-rc.1"), {
    tag: "v0.1.0-rc.1",
    version: "0.1.0-rc.1",
    releaseClass: "prerelease",
    isPrerelease: true,
  });
  assert.throws(
    () => validateReleaseTag("v0.1.0", "0.1.1"),
    /does not match authoritative Cargo version/i,
  );
});

test("workflow publishes tagged builds without the retired evidence gate", () => {
  assert.doesNotMatch(
    workflow,
    /stable_acceptance:|STABLE_ACCEPTANCE_EVIDENCE_BASE64/,
  );
  assert.match(workflow, /needs: \[build, classify_release\]/);
  assert.match(workflow, /needs\.build\.result == 'success'/);
  assert.match(workflow, /--prerelease/);
  assert.match(workflow, /prerelease\)/);
  assert.match(workflow, /stable\)/);
  assert.match(workflow, /expected_prerelease/);
  assert.match(workflow, /--retry 3 --retry-all-errors/);
  assert.match(
    workflow,
    /notes_template="docs\/releases\/\$\{GITHUB_REF_NAME\}\.md"/,
  );
  assert.match(workflow, /notes_file="\$RUNNER_TEMP\/release-notes\.md"/);
});

test("release workflow keeps publication tag-only and covers every target", () => {
  assert.match(workflow, /push:\n    tags: \['v\*'\]/);
  assert.match(
    workflow,
    /publish:\n    if: >-[\s\S]{0,300}startsWith\(github\.ref, 'refs\/tags\/'\)/,
  );
  for (const target of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
  ]) {
    assert.match(workflow, new RegExp(target));
  }
  assert.match(
    workflow,
    /os: macos-15\n            target: aarch64-apple-darwin/,
  );
  assert.match(
    workflow,
    /os: macos-15-intel\n            target: x86_64-apple-darwin/,
  );
  assert.doesNotMatch(workflow, /macos-13/);
  assert.match(
    workflow,
    /concurrency:\n  group: release-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false/,
  );
});

test("release version has one authoritative SemVer value", () => {
  assert.ok(cargoVersion, "Cargo package version");
  assert.match(cargoVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(
    !workflow.includes(cargoVersion),
    "workflow must derive, not duplicate, the Cargo version",
  );
  assert.ok(packager.includes("server/Cargo.toml"));
  assert.match(packager, /version=\$\(sed /);
  assert.ok(artifactVerifier.includes("server/Cargo.toml"));
  assert.match(artifactVerifier, /server\.listen\(0,"127\.0\.0\.1"/);
  assert.match(artifactVerifier, /export HERDR_MISE_PORT="\$port"/);
  assert.match(artifactVerifier, /"\$binary" --help/);
  assert.match(artifactVerifier, /"\$binary" --version/);
  assert.match(releaseValidator, /scripts\/package-release\.sh/);
  assert.match(releaseValidator, /scripts\/verify-release-artifact\.sh/);
  assert.match(
    workflow,
    /node scripts\/release-policy\.mjs classify-tag "\$GITHUB_REF_NAME"/,
  );
});

test("packaging normalizes archive ownership with native GNU and BSD tar flags", () => {
  assert.match(packager, /tar --version .*grep -q 'GNU tar'/);
  assert.match(packager, /--owner=0 --group=0 --numeric-owner/);
  assert.match(packager, /--uid 0 --gid 0 --uname root --gname root/);
  assert.match(
    packager,
    /-cf "\$tarball" herdr-mise LICENSE THIRD_PARTY_NOTICES\.txt/,
  );
  assert.match(packager, /gzip -n <"\$tarball"/);
  assert.doesNotMatch(packager, /tar .*\| gzip/);
});

test("packaged browser smoke proves bundled fonts load", () => {
  assert.match(
    browserSmoke,
    /document\.fonts\.load\('16px "Instrument Sans"'\)/,
  );
  assert.match(browserSmoke, /document\.fonts\.load\('16px Silkscreen'\)/);
});

test("tagged macOS builds sign, notarize, and clean ephemeral credentials", () => {
  for (const token of [
    "codesign --force --options runtime --timestamp",
    "notarytool submit",
    "codesign --verify --deep --strict",
    "security delete-keychain",
  ]) {
    assert.ok(workflow.includes(token), token);
  }
  assert.ok(
    !workflow.includes("spctl --assess"),
    "standalone CLIs are not Gatekeeper app assessment targets",
  );
  assert.match(
    workflow,
    /security delete-keychain "\$RUNNER_TEMP\/release-signing\.keychain-db"/,
  );
  assert.match(workflow, /VERIFY_CODESIGN=1/);
  assert.match(artifactVerifier, /codesign --verify --deep --strict/);
  assert.match(artifactVerifier, /anchor apple generic/);
  assert.match(artifactVerifier, /1\.2\.840\.113635\.100\.6\.1\.13/);
  assert.match(artifactVerifier, /Authority=Developer ID Application:/);
  assert.match(artifactVerifier, /flags=.*runtime/);
  assert.match(artifactVerifier, /\^Timestamp=/);
});

test("standalone CLI verification uses notarization and code-signature evidence", () => {
  assert.ok(!readme.includes("spctl --assess --type exec"));
  assert.ok(!operations.includes("spctl --assess --type exec"));
  assert.match(operations, /VERIFY_CODESIGN=1/);
});

test("existing expected asset subsets are rerunnable but unexpected assets fail closed", () => {
  assert.match(
    workflow,
    /--json body,databaseId,isPrerelease,name,tagName >release\.json/,
  );
  assert.match(workflow, /\.name == \$tag/);
  assert.doesNotMatch(workflow, /--json [^\n]*title/);
  assert.match(
    workflow,
    /comm -23 existing-assets\.txt expected-assets\.txt >unexpected-assets\.txt/,
  );
  assert.match(workflow, /test ! -s unexpected-assets\.txt/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(workflow, /cmp "dist\/\$asset" "\$existing\/\$asset"/);
  assert.match(workflow, /gh api --paginate "\$assets_api"/);
  assert.match(workflow, /releases\/assets\/\$asset_id/);
  assert.match(
    workflow,
    /https:\/\/uploads\.github\.com\/repos\/\$GITHUB_REPOSITORY\/releases\/\$release_id\/assets/,
  );
  assert.doesNotMatch(publishShell, /releases\/tags\//);
  assert.match(workflow, /gh release create .* --draft /);
  assert.match(workflow, /gh release edit .* --draft=false/);
  assert.match(workflow, /diff -u expected-assets\.txt published-assets\.txt/);
});

test("new draft publication uses release identity and publishes exactly six assets", () => {
  for (const prerelease of [false, true]) {
    const fixture = publishFixture({ prerelease });
    try {
      const { status, stderr, state } = fixture.run();
      assert.equal(status, 0, stderr);
      assert.equal(state.release.databaseId, 12345);
      assert.equal(state.release.isPrerelease, prerelease);
      assert.equal(state.published, true);
      assert.deepEqual(
        state.assets.map((a) => a.name).sort(),
        Object.keys(fixture.assets).sort(),
      );
      for (const asset of state.assets) {
        assert.deepEqual(
          Buffer.from(asset.bytes, "base64"),
          fixture.assets[asset.name],
        );
      }
      assert.equal(state.events.at(-1), "publish");
      if (!prerelease) {
        assert.ok(
          state.release.body.startsWith(
            readFileSync("docs/releases/v0.2.0.md", "utf8").trimEnd() +
              "\n\n## Checksums\n\n",
          ),
        );
        for (const target of targets) {
          const name = `herdr-mise-v0.2.0-${target}.tar.gz`;
          assert.ok(
            state.release.body.includes(
              fixture.assets[`${name}.sha256`].toString(),
            ),
          );
        }
      }
    } finally {
      fixture.cleanup();
    }
  }
});

test("release retries compare every existing byte before uploading missing assets", () => {
  const initial = publishFixture();
  let body;
  try {
    const result = initial.run();
    assert.equal(result.status, 0, result.stderr);
    body = result.state.release.body;
  } finally {
    initial.cleanup();
  }
  const names = targets.flatMap((target) => {
    const archive = `herdr-mise-v0.2.0-${target}.tar.gz`;
    return [archive, `${archive}.sha256`];
  });
  for (const count of [2, 6]) {
    const fixture = publishFixture({
      existing: true,
      body,
      existingAssets: names.slice(0, count),
    });
    try {
      const { status, stderr, state } = fixture.run();
      assert.equal(status, 0, stderr);
      assert.equal(state.published, true);
      assert.equal(
        state.events.filter((event) => event.startsWith("compare:")).length,
        count,
      );
      assert.equal(
        state.events.filter((event) => event.startsWith("upload:")).length,
        6 - count,
      );
      const firstUpload = state.events.findIndex((event) =>
        event.startsWith("upload:"),
      );
      if (firstUpload !== -1)
        assert.equal(
          state.events
            .slice(0, firstUpload)
            .filter((event) => event.startsWith("compare:")).length,
          count,
        );
    } finally {
      fixture.cleanup();
    }
  }
});

test("release publication rejects unexpected assets and differing existing bytes before upload", () => {
  const initial = publishFixture();
  let body;
  try {
    const result = initial.run();
    assert.equal(result.status, 0, result.stderr);
    body = result.state.release.body;
  } finally {
    initial.cleanup();
  }
  const names = targets.flatMap((target) => {
    const archive = `herdr-mise-v0.2.0-${target}.tar.gz`;
    return [archive, `${archive}.sha256`];
  });
  for (const options of [
    { existingAssets: [names[0], names[1], "unexpected-on-page-two"] },
    {
      existingAssets: [names[0], names[1]],
      assetBytes: { [names[1]]: Buffer.from("different") },
    },
  ]) {
    const fixture = publishFixture({ existing: true, body, ...options });
    try {
      const { status, state } = fixture.run();
      assert.notEqual(status, 0);
      assert.equal(state.published, false);
      assert.ok(!state.events.some((event) => event.startsWith("upload:")));
      if (options.existingAssets.length === 3)
        assert.ok(!state.events.some((event) => event.startsWith("compare:")));
      else
        assert.equal(
          state.events.filter((event) => event.startsWith("compare:")).length,
          2,
        );
    } finally {
      fixture.cleanup();
    }
  }
});

test("stable draft publication preserves checked-in release notes and metadata checks", () => {
  const fixture = publishFixture();
  let body;
  try {
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    body = result.state.release.body;
  } finally {
    fixture.cleanup();
  }
  for (const options of [
    { body: body.replace("## Purpose", "## Other") },
    { body, metadata: { name: "wrong title" } },
    { body, metadata: { isPrerelease: true } },
    { body, metadata: { tagName: "v0.2.1" } },
  ]) {
    const retry = publishFixture({ existing: true, ...options });
    try {
      const { status, state } = retry.run();
      assert.notEqual(status, 0);
      assert.equal(state.published, false);
      assert.deepEqual(state.events, []);
    } finally {
      retry.cleanup();
    }
  }
});

test("release publication remains draft when identity resolution or asset upload fails", () => {
  const initial = publishFixture();
  let body;
  try {
    const result = initial.run();
    assert.equal(result.status, 0, result.stderr);
    body = result.state.release.body;
  } finally {
    initial.cleanup();
  }
  for (const options of [
    { existing: true, body, metadata: { databaseId: null } },
    { existing: true, body, metadata: { databaseId: "12345" } },
    { createdIdentity: "invalid" },
    { failUpload: true },
  ]) {
    const fixture = publishFixture(options);
    try {
      const { status, state } = fixture.run();
      assert.notEqual(status, 0);
      assert.equal(state.published, false);
      if (options.existing) assert.deepEqual(state.events, []);
    } finally {
      fixture.cleanup();
    }
  }
});

test("public verification follows successful publication", () => {
  assert.match(workflow, /verify-public-release:/);
  assert.match(workflow, /always\(\) &&/);
  assert.match(workflow, /needs\.publish\.result == 'success' &&/);
  assert.match(workflow, /needs\.classify_release\.result == 'success'/);
});
