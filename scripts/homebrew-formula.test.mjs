import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const formula = readFileSync("Formula/herdr-mise.rb", "utf8");
const rc1Digests = new Set(
  JSON.parse(
    readFileSync("docs/stable-acceptance.template.json", "utf8"),
  ).accepted_rc.artifacts.map(({ sha256 }) => sha256),
);
const targets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
];

test("formula pins each published v0.1.0 archive to its checked-in sidecar", () => {
  for (const target of targets) {
    const asset = `herdr-mise-v0.1.0-${target}.tar.gz`;
    const sidecar = readFileSync(
      `docs/releases/v0.1.0/${asset}.sha256`,
      "utf8",
    ).trim();
    const [digest, recordedAsset] = sidecar.split(/\s+/);
    assert.equal(recordedAsset, asset);
    assert.equal(rc1Digests.has(digest), false);
    assert.match(
      formula,
      new RegExp(
        `url "https://github\\.com/funsaized/herdr-mise/releases/download/v0\\.1\\.0/${asset.replaceAll(".", "\\.")}"\\s+sha256 "${digest}"`,
      ),
    );
  }
});

test("formula installs only the published binary and notices", () => {
  assert.match(formula, /bin\.install "herdr-mise"/);
  assert.match(formula, /doc\.install "LICENSE", "THIRD_PARTY_NOTICES\.txt"/);
  assert.match(formula, /\(var\/"log"\)\.mkpath/);
  assert.doesNotMatch(formula, /cargo|cmake|make|system\s/);
});

test("service runs the existing HTTP binary only when explicitly started", () => {
  const service = formula.match(/service do([\s\S]*?)\n  end/)?.[1];
  assert.ok(service);
  assert.match(service, /run opt_bin\/"herdr-mise"/);
  assert.match(service, /log_path var\/"log\/herdr-mise\.log"/);
  assert.match(service, /error_log_path var\/"log\/herdr-mise\.error\.log"/);
  assert.doesNotMatch(service, /--tui|HERDR_MISE_EXTRA_ORIGINS/);
  assert.doesNotMatch(formula, /post_install|run_at_load|plist/);
});

test("Linux instructions trust the checked-in sidecar", () => {
  const sidecar =
    "docs/releases/v0.1.0/herdr-mise-v0.1.0-x86_64-unknown-linux-gnu.tar.gz.sha256";
  for (const path of ["README.md", "docs/operations.md"]) {
    const document = readFileSync(path, "utf8");
    assert.match(document, new RegExp(sidecar.replaceAll(".", "\\.")));
    assert.doesNotMatch(
      document,
      /github\.com\/funsaized\/herdr-mise\/releases[^\s"']+\.sha256/,
    );
  }
});
