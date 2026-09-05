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
import { classifyReleaseTag, validateReleaseTag } from "./release-policy.mjs";
import { evaluateStableReleaseGate } from "./stable-release-gate.mjs";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const cargo = readFileSync("server/Cargo.toml", "utf8");
const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
const packager = readFileSync("scripts/package-release.sh", "utf8");
const artifactVerifier = readFileSync(
  "scripts/verify-release-artifact.sh",
  "utf8",
);
const browserSmoke = readFileSync("scripts/smoke-browser.mjs", "utf8");
const readme = readFileSync("README.md", "utf8");
const operations = readFileSync("docs/operations.md", "utf8");
const releasing = readFileSync("docs/releasing.md", "utf8");
const stableAcceptance = readFileSync("docs/stable-acceptance.md", "utf8");
const stableAcceptanceTemplate = JSON.parse(
  readFileSync("docs/stable-acceptance.template.json", "utf8"),
);

test("stable release contract handles the public upgrade truthfully", () => {
  assert.match(releasing, /must not be reused for another stable release/);
  assert.match(releasing, /narrow self-reference exception/);
  assert.match(releasing, /RC release deletion, RC\s+remote-tag deletion/);
  assert.match(releasing, /APPLE_CERTIFICATE_P12_BASE64/);
  assert.match(releasing, /git tag -a "\$TAG"/);
  assert.match(releasing, /There is no stapling target/);

  assert.match(stableAcceptance, /valid prior public version/);
  assert.match(stableAcceptance, /real installer\s+upgrade/);
  assert.match(stableAcceptance, /isolated install\s+root/);
  assert.match(stableAcceptance, /production public-artifact\s+verifier/);
  assert.match(stableAcceptance, /not\s+a synthetic first-release fixture/);
  assert.match(stableAcceptance, /no\s+temporary selector/);
  assert.match(stableAcceptance, /```sh\nset -e\n/);
  assert.match(
    stableAcceptance,
    /https:\/\/github\.com\/funsaized\/herdr-mise\/releases\/download\/v0\.2\.0-rc\.1/,
  );
  assert.match(
    stableAcceptance,
    /https:\/\/github\.com\/funsaized\/herdr-mise\/releases\/download\/v0\.1\.0/,
  );
  assert.match(stableAcceptance, /INSTALL_ROOT\/herdr-mise\/current\.next/);
  assert.match(
    stableAcceptance,
    /e4cf8c06845a8fe764042b38816004aa4e23e5abed209f2245ea3b00ec2b9b57/,
  );
  assert.match(
    stableAcceptance,
    /test -x "\$install_root\/herdr-mise\/0\.1\.0\/bin\/herdr-mise"/,
  );
  assert.match(stableAcceptance, /current\/bin\/herdr-mise" --tui/);
  assert.match(stableAcceptance, /confirm the first render,\s+then press `q`/i);
  assert.doesNotMatch(stableAcceptance, /current\/bin\/herdr-mise" --version/);
  assert.match(
    stableAcceptance,
    /VoiceOver speech\/focus listening remains outside[\s\S]*not recorded as `PASS`/,
  );
  assert.equal(
    stableAcceptanceTemplate.gates.some(
      ({ gate_id }) => gate_id === "voiceover-speech-focus",
    ),
    false,
    "deferred VoiceOver listening must not become a required PASS row",
  );

  const upgrade = stableAcceptanceTemplate.gates.find(
    ({ gate_id }) => gate_id === "upgrade",
  );
  assert.ok(upgrade, "the schema-compatible upgrade gate ID must be retained");
  assert.match(upgrade.command_or_action, /public v0\.1\.0-to-RC upgrade/);
  assert.match(upgrade.command_or_action, /isolated install root/);
  assert.match(
    upgrade.command_or_action,
    /production public-artifact verifier/,
  );
  assert.match(upgrade.command_or_action, /exact RC checksum and path/);
  assert.match(
    upgrade.command_or_action,
    /prior public v0\.1\.0 release remains available for rollback/,
  );
  assert.match(
    upgrade.command_or_action,
    /INSTALL_ROOT\/herdr-mise\/current\.next/,
  );
  assert.match(upgrade.command_or_action, /launch succeeds from current/);
  assert.doesNotMatch(upgrade.command_or_action, /;/);

  assert.match(workflow, /environment: stable-release/);
  assert.match(workflow, /STABLE_ACCEPTANCE_EVIDENCE_BASE64/);
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

function createStableGateFixture(result = "PASS", emitPassMarker = true) {
  const temp = mkdtempSync(join(tmpdir(), "herdr-mise-stable-gate-"));
  const evidence = join(temp, "evidence.json");
  const validator = join(temp, "validator.mjs");
  const tag = "v0.1.0";
  const commit = "a".repeat(40);
  writeFileSync(
    evidence,
    `${JSON.stringify({
      accepted_rc: {
        tag: "v0.1.0-rc.1",
        version: "0.1.0-rc.1",
        commit: "b".repeat(40),
        artifacts: [
          {
            target: "aarch64-apple-darwin",
            archive: "herdr-mise-v0.1.0-rc.1-aarch64-apple-darwin.tar.gz",
            sha256: "c".repeat(64),
          },
        ],
      },
      promotion: {
        tag,
        version: "0.1.0",
        commit,
      },
      result,
    })}\n`,
  );
  writeFileSync(
    validator,
    `import { readFileSync } from "node:fs";
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const evidence = JSON.parse(readFileSync(value("--evidence"), "utf8"));
const candidate = evidence.promotion;
const exact = candidate.tag === value("--promotion-tag") &&
  candidate.version === value("--promotion-version") &&
  candidate.commit === value("--promotion-commit");
if (!exact || evidence.result !== "PASS") process.exit(1);
${emitPassMarker ? 'process.stdout.write("acceptance_evidence=PASS\\n");' : ""}
`,
  );
  return { temp, evidence, validator, tag, commit };
}

test("RC release evaluation does not require stable acceptance evidence", () => {
  assert.deepEqual(
    evaluateStableReleaseGate({
      tag: "v0.1.0-rc.1",
      cargoVersion: "0.1.0-rc.1",
      commit: "a".repeat(40),
    }),
    { required: false, releaseClass: "prerelease" },
  );
});

test("stable release evaluation fails closed without evidence", () => {
  const fixture = createStableGateFixture();
  try {
    assert.throws(
      () =>
        evaluateStableReleaseGate({
          tag: fixture.tag,
          cargoVersion: "0.1.0",
          commit: fixture.commit,
          validatorPath: fixture.validator,
        }),
      /stable acceptance evidence path is required/i,
    );
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("stable release evaluation rejects failed or incomplete evidence", () => {
  const fixture = createStableGateFixture("NOT_RUN");
  try {
    assert.throws(
      () =>
        evaluateStableReleaseGate({
          tag: fixture.tag,
          cargoVersion: "0.1.0",
          commit: fixture.commit,
          evidencePath: fixture.evidence,
          validatorPath: fixture.validator,
        }),
      /acceptance evidence validation failed/i,
    );
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("stable release evaluation rejects a validator that exits zero without its PASS marker", () => {
  const fixture = createStableGateFixture("PASS", false);
  try {
    assert.throws(
      () =>
        evaluateStableReleaseGate({
          tag: fixture.tag,
          cargoVersion: "0.1.0",
          commit: fixture.commit,
          evidencePath: fixture.evidence,
          validatorPath: fixture.validator,
        }),
      /required PASS marker/i,
    );
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("stable release evaluation accepts complete RC evidence for the exact promotion", () => {
  const fixture = createStableGateFixture();
  try {
    assert.deepEqual(
      evaluateStableReleaseGate({
        tag: fixture.tag,
        cargoVersion: "0.1.0",
        commit: fixture.commit,
        evidencePath: fixture.evidence,
        validatorPath: fixture.validator,
      }),
      {
        required: true,
        releaseClass: "stable",
      },
    );
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("workflow gates stable publication before release creation and keeps RCs prereleases", () => {
  assert.match(workflow, /stable_acceptance:\n[\s\S]*needs: classify_release/);
  assert.match(workflow, /environment: stable-release/);
  assert.match(workflow, /STABLE_ACCEPTANCE_EVIDENCE_BASE64/);
  const stableGate = workflow.indexOf("stable_acceptance:");
  const publish = workflow.indexOf("publish:");
  const create = workflow.indexOf("gh release create");
  assert.ok(stableGate >= 0 && stableGate < publish && publish < create);
  assert.match(workflow, /needs\.stable_acceptance\.result == 'success'/);
  const stableJob = workflow.slice(stableGate, publish);
  assert.doesNotMatch(
    stableJob,
    /download-artifact|--artifacts|artifact-sha256/,
  );
  assert.match(stableJob, /--promotion-tag "\$GITHUB_REF_NAME"/);
  assert.match(stableJob, /--promotion-commit "\$GITHUB_SHA"/);
  assert.match(workflow, /--prerelease/);
  assert.match(workflow, /release_class.*prerelease/);
  assert.match(workflow, /release_class.*stable/);
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
    /--json body,isPrerelease,name,tagName >release\.json/,
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
  assert.match(workflow, /gh release create .* --draft /);
  assert.match(workflow, /gh release edit .* --draft=false/);
  assert.match(workflow, /diff -u expected-assets\.txt published-assets\.txt/);
});

test("public verification survives the intentionally skipped prerelease stable gate", () => {
  assert.match(workflow, /verify-public-release:/);
  assert.match(workflow, /always\(\) &&/);
  assert.match(workflow, /needs\.publish\.result == 'success' &&/);
  assert.match(workflow, /needs\.classify_release\.result == 'success'/);
});
