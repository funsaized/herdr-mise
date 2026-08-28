import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateEvidenceManifest } from "./verification-evidence.mjs";
import { validateManagedEvidenceManifest } from "./managed-verification-evidence.mjs";

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

const managedPolicy = {
  schemaVersion: 2,
  workflow: {
    id: "3c4c0907-55c3-41a2-b89f-84a8fae531c4",
    name: "verification",
    path: "package.json",
  },
  producer: {
    repository: "funsaized/herdr-mise",
    workflowPath: ".github/workflows/swamp-managed-verification.yml",
    workflowRef:
      "funsaized/herdr-mise/.github/workflows/swamp-managed-verification.yml@refs/heads/main",
    codeOwners: ["funsaized"],
  },
  maxAgeHours: 24,
  configurationFiles: ["package.json"],
  artifacts: ["client/dist", "target/release/herdr-mise"],
  steps: [
    {
      name: "subject-preflight",
      modelName: "verification-source-git",
      modelType: "@swamp/git",
      method: "subject_preflight",
      outputs: ["subjectResult"],
    },
    {
      name: "npm-check",
      modelName: "verification-root",
      modelType: "@funsaized/npm/project",
      method: "run_subject",
      operation: "run",
      projectDir: ".",
      argv: ["npm", "run", "test"],
      outputs: ["invocation", "log"],
    },
    {
      name: "rust-check",
      modelName: "verification-rust",
      modelType: "@funsaized/herdr-mise-rust",
      method: "verify",
      checks: ["test"],
      outputs: ["result"],
    },
  ],
};
const managedPolicyBytes = Buffer.from(JSON.stringify(managedPolicy));
const managedRequest = {
  schemaVersion: 1,
  repository: "funsaized/herdr-mise",
  prNumber: 1,
  head: { repository: "funsaized/herdr-mise", repositoryId: "1", sha: commit },
  base: { repository: "funsaized/herdr-mise", branch: "main", sha: commit },
  actor: "funsaized",
  controlSha: commit,
  trustBoundary: false,
  workflow: {
    id: "123",
    path: managedPolicy.producer.workflowPath,
    ref: managedPolicy.producer.workflowRef,
    runId: "456",
    runAttempt: "1",
    actor: "funsaized",
  },
};
const managedGate = {
  schemaVersion: 1,
  repository: "funsaized/herdr-mise",
  currentMainSha: commit,
  workflow: {
    ...managedRequest.workflow,
    event: "workflow_dispatch",
    headBranch: "main",
    headSha: commit,
    conclusion: "success",
  },
  pr: {
    number: 1,
    state: "open",
    head: managedRequest.head,
    base: managedRequest.base,
  },
};

function managedTiming() {
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const completedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
  return { startedAt, completedAt, durationMs: 1000 };
}

function managedFixture() {
  const timing = managedTiming();
  const step = (identity, records) => ({
    ...identity,
    status: "succeeded",
    ...timing,
    records,
  });
  return seal({
    schemaVersion: 2,
    source: {
      repository: managedRequest.head.repository,
      repositoryId: managedRequest.head.repositoryId,
      commit,
      tree,
    },
    base: {
      repository: managedRequest.base.repository,
      branch: managedRequest.base.branch,
      commit: managedRequest.base.sha,
    },
    control: {
      repository: managedRequest.repository,
      commit,
      policySha256: sha256(managedPolicyBytes),
      workflowSha256: sha256(readFileSync("package.json")),
      swampVersion: "20260827.184833.0-sha.test",
    },
    producer: {
      kind: "github-actions",
      githubRepository: managedRequest.repository,
      workflowPath: managedRequest.workflow.path,
      workflowRef: managedRequest.workflow.ref,
      workflowId: managedRequest.workflow.id,
      runId: managedRequest.workflow.runId,
      runAttempt: managedRequest.workflow.runAttempt,
      dispatchActor: managedRequest.actor,
    },
    workflow: { ...managedPolicy.workflow, runId: crypto.randomUUID() },
    configuration: {
      algorithm: "sha256",
      files: { "package.json": sha256(readFileSync("package.json")) },
    },
    steps: [
      step(
        {
          name: "subject-preflight",
          modelName: "verification-source-git",
          modelType: "@swamp/git",
          method: "subject_preflight",
        },
        [
          record("subjectResult", {
            commit,
            tree,
            baseCommit: commit,
            clean: true,
            ...timing,
          }),
        ],
      ),
      step(
        {
          name: "npm-check",
          modelName: "verification-root",
          modelType: "@funsaized/npm/project",
          method: "run_subject",
        },
        [
          record("invocation", {
            operation: "run",
            argv: ["npm", "run", "test"],
            projectDir: ".",
            executionStatus: "succeeded",
            exitCode: 0,
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
            ...timing,
          }),
          record("log", "npm output"),
        ],
      ),
      step(
        {
          name: "rust-check",
          modelName: "verification-rust",
          modelType: "@funsaized/herdr-mise-rust",
          method: "verify",
        },
        [
          record("result", {
            status: "passed",
            gitHead: commit,
            cargoLockSha256: sha256(readFileSync("Cargo.lock")),
            checks: [{ name: "test", status: "passed" }],
            ...timing,
          }),
        ],
      ),
    ],
    artifacts: fixture().artifacts,
    verdict: "pass",
    createdAt: new Date().toISOString(),
  });
}

function validateManaged(
  manifest,
  request = managedRequest,
  gate = managedGate,
) {
  return validateManagedEvidenceManifest(
    manifest,
    managedPolicy,
    request,
    gate,
    { policyRoot: ".", subjectRoot: "." },
    managedPolicyBytes,
  );
}

test("accepts a complete managed audit record", () => {
  assert.equal(validateManaged(managedFixture()).verdict, "pass");
});

test("rejects local, stale-run, and malformed-timing managed evidence", () => {
  const local = managedFixture();
  local.producer = { kind: "local" };
  assert.throws(() => validateManaged(seal(local)), /local evidence/);

  const wrongRun = managedFixture();
  wrongRun.producer.runId = "999";
  assert.throws(() => validateManaged(seal(wrongRun)), /producer identity/);

  const badTiming = managedFixture();
  badTiming.steps[0].durationMs = -1;
  assert.throws(() => validateManaged(seal(badTiming)), /invalid duration/);
});

test("rejects failed workflows, moved heads, and non-owner trust changes", () => {
  const failed = structuredClone(managedGate);
  failed.workflow.conclusion = "failure";
  assert.throws(
    () => validateManaged(managedFixture(), managedRequest, failed),
    /did not succeed/,
  );

  const moved = structuredClone(managedGate);
  moved.pr.head.sha = "0".repeat(40);
  assert.throws(
    () => validateManaged(managedFixture(), managedRequest, moved),
    /head moved/,
  );

  const request = structuredClone(managedRequest);
  const gate = structuredClone(managedGate);
  request.trustBoundary = true;
  request.actor = "third-party";
  request.workflow.actor = "third-party";
  gate.workflow.actor = "third-party";
  assert.throws(
    () => validateManaged(managedFixture(), request, gate),
    /not allowlisted/,
  );
});

test("managed evidence rejects source, step, configuration, record, and root tampering", () => {
  const source = managedFixture();
  source.source.repository = "attacker/fork";
  assert.throws(() => validateManaged(seal(source)), /source identity/);

  const reordered = managedFixture();
  reordered.steps.reverse();
  assert.throws(() => validateManaged(seal(reordered)), /steps do not match/);

  const configuration = managedFixture();
  configuration.configuration.files["package.json"] = "0".repeat(64);
  assert.throws(
    () => validateManaged(seal(configuration)),
    /configuration does not match/,
  );

  const recordSize = managedFixture();
  recordSize.steps[0].records[0].size += 1;
  assert.throws(
    () => validateManaged(seal(recordSize)),
    /record size mismatch/,
  );

  const future = managedFixture();
  future.createdAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  assert.throws(() => validateManaged(seal(future)), /future/);

  const root = managedFixture();
  root.evidenceRootSha256 = "0".repeat(64);
  assert.throws(() => validateManaged(root), /root checksum/);
});
