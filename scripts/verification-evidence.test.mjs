import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateEvidenceManifest } from "./verification-evidence.mjs";

const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
  encoding: "utf8",
}).trim();
const remoteMain = "b".repeat(40);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function record(specName, content) {
  const bytes = Buffer.from(
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return {
    id: crypto.randomUUID(),
    name: `${specName}-${crypto.randomUUID()}`,
    version: 1,
    specName,
    contentType: specName === "log" ? "text/plain" : "application/json",
    size: bytes.length,
    sha256: sha256(bytes),
    contentBase64: bytes.toString("base64"),
  };
}

const policy = {
  workflow: {
    id: "5cc04b4f-87b6-4168-ad49-ff184b6f65e1",
    name: "local-verification",
  },
  maxAgeHours: 24,
  configurationFiles: ["package.json"],
  artifacts: ["client/dist", "target/release/herdr-mise"],
  steps: [
    {
      name: "npm-check",
      modelName: "verification-root",
      modelType: "@funsaized/npm/project",
      method: "run",
      projectDir: ".",
      argv: ["npm", "run", "test"],
      outputs: ["log", "invocation"],
    },
    {
      name: "rust-check",
      modelName: "verification-rust",
      modelType: "@funsaized/herdr-mise-rust",
      method: "verify",
      checks: ["test"],
      outputs: ["log", "result"],
    },
    {
      name: "fetch-source",
      modelName: "verification-source-git",
      modelType: "@swamp/git",
      method: "fetch",
      remote: "origin",
      outputs: ["fetchResult"],
    },
    {
      name: "lookup-remote-main",
      modelName: "verification-source-git",
      modelType: "@swamp/git",
      method: "remote_ref",
      remote: "origin",
      ref: "refs/heads/main",
      outputs: ["remoteRefResult"],
    },
    {
      name: "require-main-ancestor",
      modelName: "verification-source-git",
      modelType: "@swamp/git",
      method: "require_ancestor",
      outputs: ["ancestryResult"],
    },
  ],
};

function seal(manifest) {
  const { evidenceRootSha256: _discarded, ...unsigned } = manifest;
  return { ...unsigned, evidenceRootSha256: sha256(canonical(unsigned)) };
}

function fixture() {
  return seal({
    schemaVersion: 1,
    source: { commit, tree },
    workflow: { ...policy.workflow, runId: crypto.randomUUID() },
    configuration: {
      algorithm: "sha256",
      files: { "package.json": sha256(readFileSync("package.json")) },
    },
    steps: [
      {
        name: "npm-check",
        modelName: "verification-root",
        modelType: "@funsaized/npm/project",
        method: "run",
        status: "succeeded",
        records: [
          record("log", "npm output"),
          record("invocation", {
            executionStatus: "succeeded",
            exitCode: 0,
            operation: "run",
            argv: ["npm", "run", "test"],
            projectDir: ".",
            expectedGitHead: commit,
            gitHeadBefore: commit,
            gitHeadAfter: commit,
            cleanWorktreeBefore: true,
            cleanWorktreeAfter: true,
            packageJsonSha256Before: sha256(readFileSync("package.json")),
            packageJsonSha256After: sha256(readFileSync("package.json")),
            lockfilePath: "package-lock.json",
            lockfileSha256Before: sha256(readFileSync("package-lock.json")),
            lockfileSha256After: sha256(readFileSync("package-lock.json")),
          }),
        ],
      },
      {
        name: "rust-check",
        modelName: "verification-rust",
        modelType: "@funsaized/herdr-mise-rust",
        method: "verify",
        status: "succeeded",
        records: [
          record("log", "cargo output"),
          record("result", {
            status: "passed",
            gitHead: commit,
            cargoLockSha256: sha256(readFileSync("Cargo.lock")),
            checks: [{ name: "test", status: "passed" }],
          }),
        ],
      },
      {
        name: "fetch-source",
        modelName: "verification-source-git",
        modelType: "@swamp/git",
        method: "fetch",
        status: "succeeded",
        records: [
          record("fetchResult", {
            remote: "origin",
            tags: false,
            pruned: false,
            raw: "",
          }),
        ],
      },
      {
        name: "lookup-remote-main",
        modelName: "verification-source-git",
        modelType: "@swamp/git",
        method: "remote_ref",
        status: "succeeded",
        records: [
          record("remoteRefResult", {
            remote: "origin",
            ref: "refs/heads/main",
            sha: remoteMain,
          }),
        ],
      },
      {
        name: "require-main-ancestor",
        modelName: "verification-source-git",
        modelType: "@swamp/git",
        method: "require_ancestor",
        status: "succeeded",
        records: [
          record("ancestryResult", {
            ancestor: remoteMain,
            descendant: commit,
            isAncestor: true,
          }),
        ],
      },
    ],
    artifacts: [
      {
        path: "client/dist",
        files: [
          {
            path: "client/dist/index.html",
            size: 1,
            executable: false,
            sha256: "a".repeat(64),
          },
        ],
      },
      {
        path: "target/release/herdr-mise",
        files: [
          {
            path: "target/release/herdr-mise",
            size: 1,
            executable: true,
            sha256: "b".repeat(64),
          },
        ],
      },
    ],
    verdict: "pass",
    createdAt: new Date().toISOString(),
  });
}

test("accepts complete commit-bound evidence", () => {
  assert.equal(
    validateEvidenceManifest(fixture(), policy, commit).verdict,
    "pass",
  );
});

test("rejects wrong commits and changed verification configuration", () => {
  const wrongCommit = fixture();
  wrongCommit.source.commit = "0".repeat(40);
  assert.throws(
    () => validateEvidenceManifest(seal(wrongCommit), policy, commit),
    /wrong commit/,
  );

  const changedConfiguration = fixture();
  changedConfiguration.configuration.files["package.json"] = "0".repeat(64);
  assert.throws(
    () => validateEvidenceManifest(seal(changedConfiguration), policy, commit),
    /configuration does not match/,
  );
});

test("rejects missing, duplicate, and skipped controls", () => {
  const missing = fixture();
  missing.steps.pop();
  assert.throws(
    () => validateEvidenceManifest(seal(missing), policy, commit),
    /steps do not match/,
  );

  const duplicate = fixture();
  duplicate.steps.push(structuredClone(duplicate.steps[0]));
  assert.throws(
    () => validateEvidenceManifest(seal(duplicate), policy, commit),
    /steps do not match/,
  );

  const skipped = fixture();
  skipped.steps[0].status = "skipped";
  assert.throws(
    () => validateEvidenceManifest(seal(skipped), policy, commit),
    /identity or status/,
  );
});

test("rejects commands and check sets that differ from policy", () => {
  const wrongCommand = fixture();
  const invocation = JSON.parse(
    Buffer.from(
      wrongCommand.steps[0].records[1].contentBase64,
      "base64",
    ).toString(),
  );
  invocation.argv = ["npm", "run", "lint"];
  wrongCommand.steps[0].records[1] = record("invocation", invocation);
  assert.throws(
    () => validateEvidenceManifest(seal(wrongCommand), policy, commit),
    /command does not match policy/,
  );

  const wrongRustChecks = fixture();
  const rustResult = JSON.parse(
    Buffer.from(
      wrongRustChecks.steps[1].records[1].contentBase64,
      "base64",
    ).toString(),
  );
  rustResult.checks = [{ name: "different", status: "passed" }];
  wrongRustChecks.steps[1].records[1] = record("result", rustResult);
  assert.throws(
    () => validateEvidenceManifest(seal(wrongRustChecks), policy, commit),
    /checks do not match policy/,
  );
});

test("rejects ancestry that is not bound to the looked-up remote main", () => {
  const wrongAncestry = fixture();
  const ancestry = JSON.parse(
    Buffer.from(
      wrongAncestry.steps[4].records[0].contentBase64,
      "base64",
    ).toString(),
  );
  ancestry.ancestor = "c".repeat(40);
  wrongAncestry.steps[4].records[0] = record("ancestryResult", ancestry);
  assert.throws(
    () => validateEvidenceManifest(seal(wrongAncestry), policy, commit),
    /ancestry is not bound to remote main/,
  );
});

test("rejects tampered records, bad roots, stale evidence, and path escapes", () => {
  const tampered = fixture();
  tampered.steps[0].records[0].contentBase64 =
    Buffer.from("changed").toString("base64");
  assert.throws(
    () => validateEvidenceManifest(seal(tampered), policy, commit),
    /record (size|checksum) mismatch/,
  );

  const badRoot = fixture();
  badRoot.evidenceRootSha256 = "0".repeat(64);
  assert.throws(
    () => validateEvidenceManifest(badRoot, policy, commit),
    /root checksum/,
  );

  const stale = fixture();
  stale.createdAt = "2000-01-01T00:00:00.000Z";
  assert.throws(
    () => validateEvidenceManifest(seal(stale), policy, commit),
    /stale/,
  );

  const escaped = fixture();
  escaped.artifacts[0].files[0].path = "../outside";
  assert.throws(
    () => validateEvidenceManifest(seal(escaped), policy, commit),
    /path escapes repository/,
  );
});
