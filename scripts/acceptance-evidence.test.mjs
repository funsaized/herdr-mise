import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isMainModule } from "./validate-acceptance-evidence.mjs";

const promotion = {
  tag: "v0.2.0",
  version: "0.2.0",
  commit: "a".repeat(40),
};
const rcArtifacts = [
  [
    "aarch64-apple-darwin",
    "e4cf8c06845a8fe764042b38816004aa4e23e5abed209f2245ea3b00ec2b9b57",
  ],
  [
    "x86_64-apple-darwin",
    "bad9caf8073a9bfc2a580d537a22de7968a8a6e37f29f711470bf61db121faf8",
  ],
  [
    "x86_64-unknown-linux-gnu",
    "bbcb6ab7cf31216313b42692cbb9a3025cdf35e692787e2340ea13b22e116229",
  ],
].map(([target, sha256]) => {
  const archive = `herdr-mise-v0.2.0-rc.1-${target}.tar.gz`;
  const archive_url = `https://github.com/funsaized/herdr-mise/releases/download/v0.2.0-rc.1/${archive}`;
  return {
    target,
    archive,
    sha256,
    archive_url,
    checksum_url: `${archive_url}.sha256`,
  };
});
const acceptedRc = {
  tag: "v0.2.0-rc.1",
  version: "0.2.0-rc.1",
  commit: "85440d6577ab12a8c087c1c0919d896503164dc3",
  artifacts: rcArtifacts,
};
const categories = {
  "validate-release": "automated",
  perf: "automated",
  "public-artifact": "automated",
  "live-supported-herdr": "automated",
  "startup-recovery": "automated",
  "source-loss-reconnect": "automated",
  "connected-no-agent": "automated",
  "visual-1-light": "automated",
  "visual-1-dinner": "automated",
  "visual-6-light": "automated",
  "visual-6-dinner": "automated",
  "visual-12-light": "automated",
  "visual-12-dinner": "automated",
  "tui-test-suite": "automated",
  "tui-responsive-terminal": "manual",
  keyboard: "manual",
  "runtime-reduced-motion": "manual",
  "blocked-recognition-two-meters": "manual",
  upgrade: "manual",
  uninstall: "manual",
};

const executedAgainst = () => ({
  tag: acceptedRc.tag,
  version: acceptedRc.version,
  commit: acceptedRc.commit,
  artifacts: rcArtifacts.map(({ target, archive, sha256 }) => ({
    target,
    archive,
    sha256,
  })),
});

function validDocument() {
  return {
    schema_version: 2,
    accepted_rc: structuredClone(acceptedRc),
    promotion: { ...promotion },
    gates: Object.entries(categories).map(([gate_id, category]) => ({
      gate_id,
      category,
      scope: "full-product",
      tester:
        category === "automated" ? "release-automation" : "acceptance-tester",
      platform: "macOS 15 arm64",
      executed_against: executedAgainst(),
      command_or_action:
        category === "automated"
          ? `npm run acceptance:${gate_id}`
          : `Observe and record the ${gate_id} acceptance procedure`,
      result: "PASS",
      timestamp: "2026-08-12T20:00:00Z",
      evidence_ref: `external://acceptance/${gate_id}.log`,
    })),
  };
}

function validate(document, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mise-evidence-"));
  const evidence = join(directory, "evidence.json");
  writeFileSync(evidence, JSON.stringify(document));
  const args = {
    "--promotion-tag": promotion.tag,
    "--promotion-version": promotion.version,
    "--promotion-commit": promotion.commit,
    ...overrides,
  };
  return spawnSync(
    process.execPath,
    [
      "scripts/validate-acceptance-evidence.mjs",
      "--evidence",
      evidence,
      ...Object.entries(args).flat(),
    ],
    { encoding: "utf8" },
  );
}

function assertSchema(value, schema, root, path = "document") {
  if (schema.$ref) {
    const target = schema.$ref
      .slice(2)
      .split("/")
      .reduce((current, part) => current[part], root);
    return assertSchema(value, target, root, path);
  }
  if ("const" in schema) assert.deepEqual(value, schema.const, path);
  if (schema.enum) assert.ok(schema.enum.includes(value), path);
  if (schema.type === "object") {
    assert.ok(
      value && typeof value === "object" && !Array.isArray(value),
      path,
    );
    for (const required of schema.required ?? [])
      assert.ok(required in value, `${path}.${required} is required`);
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        assert.ok(
          key in (schema.properties ?? {}),
          `${path}.${key} is unknown`,
        );
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (key in value) assertSchema(value[key], child, root, `${path}.${key}`);
  }
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), path);
    if (schema.minItems !== undefined)
      assert.ok(value.length >= schema.minItems, path);
    if (schema.maxItems !== undefined)
      assert.ok(value.length <= schema.maxItems, path);
    value.forEach((item, index) =>
      assertSchema(item, schema.items, root, `${path}[${index}]`),
    );
  }
  if (schema.type === "string") {
    assert.equal(typeof value, "string", path);
    if (schema.minLength !== undefined)
      assert.ok(value.length >= schema.minLength, path);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), path);
  }
}

test("accepts exact public RC execution and separate stable promotion context", () => {
  const result = validate(validDocument());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "acceptance_evidence=PASS");
});

for (const [name, mutate, message] of [
  ["missing row", (d) => d.gates.pop(), "missing required gate"],
  ["NOT_RUN", (d) => (d.gates[0].result = "NOT_RUN"), "must be PASS"],
  ["FAIL", (d) => (d.gates[0].result = "FAIL"), "must be PASS"],
  [
    "RC commit mismatch",
    (d) => (d.gates[0].executed_against.commit = "d".repeat(40)),
    "executed_against RC mismatch",
  ],
  [
    "accepted RC commit mismatch",
    (d) => (d.accepted_rc.commit = "d".repeat(40)),
    "accepted_rc commit does not match public v0.2.0-rc.1",
  ],
  [
    "published checksum mismatch",
    (d) => (d.accepted_rc.artifacts[0].sha256 = "d".repeat(64)),
    "published RC sidecar",
  ],
  [
    "artifact absent from allowlist",
    (d) => (d.gates[0].executed_against.artifacts[0].sha256 = "d".repeat(64)),
    "artifact is not in accepted_rc",
  ],
  [
    "missing supported artifact",
    (d) => d.accepted_rc.artifacts.pop(),
    "exactly the three supported targets",
  ],
  [
    "duplicate artifact",
    (d) => (d.accepted_rc.artifacts[2] = { ...d.accepted_rc.artifacts[0] }),
    "duplicate accepted_rc artifact",
  ],
  [
    "wrong RC tag URL",
    (d) =>
      (d.accepted_rc.artifacts[0].archive_url =
        d.accepted_rc.artifacts[0].archive_url.replace("rc.1", "rc.2")),
    "archive_url",
  ],
  [
    "non-HTTPS checksum URL",
    (d) =>
      (d.accepted_rc.artifacts[0].checksum_url =
        "http://github.com/funsaized/file.sha256"),
    "checksum_url",
  ],
  [
    "duplicate gate",
    (d) => d.gates.push(structuredClone(d.gates[0])),
    "duplicate required gate",
  ],
  ["unknown field", (d) => (d.gates[0].notes = "no"), "unknown field"],
  [
    "category mismatch",
    (d) => (d.gates[0].category = "manual"),
    "category mismatch",
  ],
  [
    "placeholder action",
    (d) => (d.gates[0].command_or_action = "run HTTPS_ARCHIVE_URL"),
    "placeholder",
  ],
  [
    "shell control operator",
    (d) => (d.gates[0].command_or_action = "npm test && true"),
    "malformed command_or_action",
  ],
  ["bad timestamp", (d) => (d.gates[0].timestamp = "yesterday"), "timestamp"],
  [
    "placeholder platform",
    (d) => (d.gates[0].platform = "REPLACE_WITH_OS_AND_ARCH"),
    "placeholder",
  ],
  [
    "NOT_RUN evidence marker in PASS row",
    (d) => (d.gates[0].evidence_ref = "external://NOT_RUN"),
    "placeholder",
  ],
  [
    "sentinel timestamp in PASS row",
    (d) => (d.gates[0].timestamp = "1970-01-01T00:00:00Z"),
    "placeholder",
  ],
  [
    "private home path",
    (d) => (d.gates[0].evidence_ref = "/Users/private/workspace/log.txt"),
    "private data",
  ],
  [
    "private home path in file URL",
    (d) =>
      (d.gates[0].evidence_ref = "file:///Users/private/workspace/log.txt"),
    "private data",
  ],
  [
    "scoped override",
    (d) => {
      d.gates[0].scope = "scoped-subsystem";
      d.gates.push(structuredClone(d.gates[0]));
    },
    "missing required gate",
  ],
]) {
  test(`fails closed for ${name}`, () => {
    const document = validDocument();
    mutate(document);
    const result = validate(document);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(message));
  });
}

test("rejects mismatch against workflow-supplied promotion context", () => {
  const result = validate(validDocument(), { "--promotion-tag": "v0.1.1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /promotion context mismatch/);
});

test("resolved-path main guard handles URL-encoded filesystem characters", () => {
  const script = join(tmpdir(), "validator%#copy.mjs");
  assert.equal(isMainModule(script, pathToFileURL(script).href), true);
});

test("schema gate enum and template stay aligned with validator policy", () => {
  const schema = JSON.parse(
    readFileSync("docs/acceptance-evidence.schema.json", "utf8"),
  );
  const template = JSON.parse(
    readFileSync("docs/stable-acceptance.template.json", "utf8"),
  );
  assert.equal(schema.properties.schema_version.const, 2);
  assert.deepEqual(
    schema.$defs.gate.properties.gate_id.enum.slice().sort(),
    Object.keys(categories).sort(),
  );
  assert.deepEqual(
    template.gates.map((row) => row.gate_id).sort(),
    Object.keys(categories).sort(),
  );
  assert.equal(template.accepted_rc.tag, "v0.2.0-rc.1");
  assert.equal(template.accepted_rc.version, "0.2.0-rc.1");
  const contract = JSON.parse(
    readFileSync("acceptance/releases/v0.2.0.json", "utf8"),
  );
  assert.equal(contract.acceptedRcCommit, acceptedRc.commit);
  assert.match(
    acceptedRc.commit,
    new RegExp(schema.$defs.acceptedRc.properties.commit.pattern),
  );
  assert.match(
    acceptedRc.commit,
    new RegExp(schema.$defs.executedAgainst.properties.commit.pattern),
  );
  assert.equal(schema.$defs.acceptedRc.properties.commit.const, undefined);
  assert.deepEqual(
    template.accepted_rc.artifacts.map((artifact) => artifact.target).sort(),
    rcArtifacts.map((artifact) => artifact.target).sort(),
  );
  assert.ok(template.gates.every((row) => row.result === "NOT_RUN"));
  assert.ok(
    template.gates.every((row) => row.executed_against.tag === "v0.2.0-rc.1"),
  );
  assertSchema(template, schema, schema);
});
