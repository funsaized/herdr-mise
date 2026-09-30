import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { checkReleaseConsistency } from "./check-release-consistency.mjs";

const files = [
  "server/Cargo.toml",
  "herdr-plugin.toml",
  "install.sh",
  "README.md",
  "SECURITY.md",
  "docs/operations.md",
  "docs/releases/v0.3.0.md",
];
const cli = resolve("scripts/check-release-consistency.mjs");
const captured = JSON.parse(
  readFileSync("scripts/fixtures/releases/v0.3.0-public.json", "utf8"),
);
const capturedLatest = JSON.parse(
  readFileSync("scripts/fixtures/releases/v0.3.0-latest.json", "utf8"),
);

function fixture(t, corrected = true) {
  const root = mkdtempSync(join(tmpdir(), "herdr-mise-consistency-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(file, join(root, file));
  }
  const release = structuredClone(captured);
  const latest = structuredClone(capturedLatest);
  if (corrected) {
    const template = readFileSync(
      join(root, "docs/releases/v0.3.0.md"),
      "utf8",
    );
    for (const metadata of [release, latest]) {
      const checksums = metadata.body.slice(
        metadata.body.indexOf("## Checksums"),
      );
      metadata.body = `${template.replace(/\n*$/, "\n\n")}${checksums}`;
      assert.equal(
        metadata.body.slice(metadata.body.indexOf("## Checksums")),
        checksums,
      );
    }
  }
  return {
    root,
    release,
    latest,
    replace(file, before, after) {
      const path = join(root, file);
      const text = readFileSync(path, "utf8");
      assert.ok(
        text.includes(before),
        `mutation must touch ${file}: ${before}`,
      );
      writeFileSync(path, text.replace(before, after));
    },
    check() {
      return checkReleaseConsistency({ root, release, latest });
    },
    run() {
      writeFileSync(join(root, "release.json"), JSON.stringify(release));
      writeFileSync(join(root, "latest.json"), JSON.stringify(latest));
      return spawnSync(process.execPath, [cli, "release.json", "latest.json"], {
        cwd: root,
        encoding: "utf8",
      });
    },
  };
}

test("release consistency accepts matching published metadata and repository guidance", (t) => {
  const f = fixture(t);
  assert.equal(f.check(), "v0.3.0");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /v0\.3\.0: release guidance is consistent/);
  // Historical guidance and upstream Herdr versions are not current Mise pins.
  f.replace(
    "docs/operations.md",
    "## Local run",
    "## Historical releases\n\nv0.2.0 was a previous release.\n\n## Local run",
  );
  f.release.body = f.release.body.replaceAll("\n", "\r\n") + "\r\n";
  assert.equal(f.check(), "v0.3.0");
});

test("release consistency rejects captured stale published release guidance", (t) => {
  const f = fixture(t, false);
  assert.equal(f.release.id, 396655343);
  assert.deepEqual(f.release, f.latest);
  assert.throws(
    () => f.check(),
    /release\.body: contains unpublished-release wording/,
  );
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /release\.body: contains unpublished-release wording/,
  );
});

test("release consistency rejects version platform and publication mismatches", (t) => {
  const mutations = [
    [
      "Cargo pin",
      (f) =>
        f.replace(
          "server/Cargo.toml",
          'version = "0.3.0"',
          'version = "0.2.0"',
        ),
      /authoritative Cargo version/,
    ],
    [
      "plugin pin",
      (f) =>
        f.replace(
          "herdr-plugin.toml",
          'version = "0.3.0"',
          'version = "0.2.0"',
        ),
      /herdr-plugin\.toml/,
    ],
    [
      "installer pin",
      (f) =>
        f.replace(
          "install.sh",
          "HERDR_MISE_VERSION=0.3.0",
          "HERDR_MISE_VERSION=0.2.0",
        ),
      /install\.sh/,
    ],
    [
      "README example",
      (f) => f.replace("README.md", "[v0.3.0]", "[v0.2.0]"),
      /README\.md Quick start.*example/,
    ],
    [
      "archive example",
      (f) => f.replace("docs/operations.md", "TAG=v0.3.0", "TAG=v0.2.0"),
      /docs\/operations\.md.*example/,
    ],
    [
      "checksum example",
      (f) =>
        f.replace(
          "docs/operations.md",
          "herdr-mise-v0.3.0-aarch64-apple-darwin.tar.gz.sha256",
          "herdr-mise-v0.2.0-aarch64-apple-darwin.tar.gz.sha256",
        ),
      /docs\/operations\.md Verifying an archive.*example/,
    ],
    [
      "prerelease checksum example",
      (f) =>
        f.replace(
          "docs/operations.md",
          "herdr-mise-v0.3.0-aarch64-apple-darwin.tar.gz.sha256",
          "herdr-mise-v0.3.0-rc.1-aarch64-apple-darwin.tar.gz.sha256",
        ),
      /docs\/operations\.md Verifying an archive.*example v0\.3\.0-rc\.1 must be v0\.3\.0/,
    ],
    [
      "availability",
      (f) =>
        f.replace(
          "docs/operations.md",
          "The current pinned public stable distribution",
          "Unavailable until the stable release is published. The current pinned public stable distribution",
        ),
      /docs\/operations\.md.*unpublished-release/,
    ],
    [
      "prospective notes",
      (f) =>
        f.replace(
          "docs/releases/v0.3.0.md",
          "Download the archive",
          "Once the stable release is published, download the archive",
        ),
      /docs\/releases\/v0\.3\.0\.md.*unpublished-release/,
    ],
    [
      "platform table",
      (f) =>
        f.replace(
          "docs/operations.md",
          "`x86_64-apple-darwin`",
          "`aarch64-unknown-linux-gnu`",
        ),
      /docs\/operations\.md.*platform/,
    ],
    [
      "extra platform",
      (f) =>
        f.replace(
          "docs/operations.md",
          "Targets:",
          "Targets:\n\n| Windows | `x86_64-pc-windows-msvc` |",
        ),
      /docs\/operations\.md platform table/,
    ],
    [
      "README baseline",
      (f) => f.replace("README.md", "glibc 2.39", "glibc 2.17"),
      /README\.md.*baseline/,
    ],
    [
      "archive baseline",
      (f) =>
        f.replace(
          "docs/operations.md",
          "Linux uses the Ubuntu 24.04",
          "Linux uses the Ubuntu 22.04",
        ),
      /docs\/operations\.md.*baseline/,
    ],
    [
      "notes exclusions",
      (f) =>
        f.replace(
          "docs/releases/v0.3.0.md",
          "Older glibc, musl, Windows, and Linux ARM are not claimed supported.",
          "All platforms supported.",
        ),
      /docs\/releases\/v0\.3\.0\.md.*platform/,
    ],
    [
      "security version",
      (f) =>
        f.replace(
          "SECURITY.md",
          "Only the newest stable release",
          "Only the newest stable release, currently v0.2.0,",
        ),
      /SECURITY\.md Supported versions/,
    ],
    [
      "security link",
      (f) =>
        f.replace("SECURITY.md", "/releases/latest", "/releases/tag/v0.2.0"),
      /SECURITY\.md Supported versions/,
    ],
    [
      "notes link",
      (f) =>
        f.replace(
          "docs/releases/v0.3.0.md",
          "/releases/tag/v0.3.0",
          "/releases/tag/v0.2.0",
        ),
      /docs\/releases\/v0\.3\.0\.md.*example/,
    ],
    [
      "public prose",
      (f) => {
        f.release.body = f.release.body.replace(
          "This release adds",
          "This release removes",
        );
      },
      /release\.body.*differs/,
    ],
    [
      "Latest prose",
      (f) => {
        f.latest.body = capturedLatest.body;
      },
      /latest\.body.*unpublished-release/,
    ],
    [
      "Latest tag",
      (f) => {
        f.latest.tag_name = "v0.2.0";
      },
      /latest\.tag_name/,
    ],
  ];
  for (const source of ["release", "latest"]) {
    mutations.push(
      [
        `${source} draft`,
        (f) => {
          f[source].draft = true;
        },
        new RegExp(`${source}\\.draft`),
      ],
      [
        `${source} prerelease`,
        (f) => {
          f[source].prerelease = true;
        },
        new RegExp(`${source}\\.prerelease`),
      ],
      [
        `${source} unpublished`,
        (f) => {
          f[source].published_at = null;
        },
        new RegExp(`${source}\\.published_at`),
      ],
      [
        `${source} missing asset`,
        (f) => {
          f[source].assets.pop();
        },
        new RegExp(`${source}\\.assets`),
      ],
      [
        `${source} duplicate asset`,
        (f) => {
          f[source].assets[0] = f[source].assets[1];
        },
        new RegExp(`${source}\\.assets`),
      ],
      [
        `${source} extra asset`,
        (f) => {
          f[source].assets.push({ name: "unexpected.zip" });
        },
        new RegExp(`${source}\\.assets`),
      ],
    );
  }
  for (const [name, mutate, diagnostic] of mutations) {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => f.check(), diagnostic, name);
  }
});
