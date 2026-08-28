import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateManagedEvidenceManifest } from "./managed-verification-evidence.mjs";

const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
  encoding: "utf8",
}).trim();

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

function seal(manifest) {
  const { evidenceRootSha256: _discarded, ...unsigned } = manifest;
  return { ...unsigned, evidenceRootSha256: sha256(canonical(unsigned)) };
}

const policy = {
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
const policyBytes = Buffer.from(JSON.stringify(policy));
const request = {
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
    path: policy.producer.workflowPath,
    ref: policy.producer.workflowRef,
    runId: "456",
    runAttempt: "1",
    actor: "funsaized",
  },
};
const gate = {
  schemaVersion: 1,
  repository: "funsaized/herdr-mise",
  currentMainSha: commit,
  workflow: {
    ...request.workflow,
    event: "workflow_dispatch",
    headBranch: "main",
    headSha: commit,
    conclusion: "success",
  },
  pr: {
    number: 1,
    state: "open",
    head: request.head,
    base: request.base,
  },
};

function timing() {
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const completedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
  return { startedAt, completedAt, durationMs: 1000 };
}

function fixture() {
  const stepTiming = timing();
  const step = (identity, records) => ({
    ...identity,
    status: "succeeded",
    ...stepTiming,
    records,
  });
  return seal({
    schemaVersion: 2,
    source: {
      repository: request.head.repository,
      repositoryId: request.head.repositoryId,
      commit,
      tree,
    },
    base: {
      repository: request.base.repository,
      branch: request.base.branch,
      commit: request.base.sha,
    },
    control: {
      repository: request.repository,
      commit,
      policySha256: sha256(policyBytes),
      workflowSha256: sha256(readFileSync("package.json")),
      swampVersion: "20260827.184833.0-sha.test",
    },
    producer: {
      kind: "github-actions",
      githubRepository: request.repository,
      workflowPath: request.workflow.path,
      workflowRef: request.workflow.ref,
      workflowId: request.workflow.id,
      runId: request.workflow.runId,
      runAttempt: request.workflow.runAttempt,
      dispatchActor: request.actor,
    },
    workflow: { ...policy.workflow, runId: crypto.randomUUID() },
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
            ...stepTiming,
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
            ...stepTiming,
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
            ...stepTiming,
          }),
        ],
      ),
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

function validate(manifest, runRequest = request, runGate = gate) {
  return validateManagedEvidenceManifest(
    manifest,
    policy,
    runRequest,
    runGate,
    { policyRoot: ".", subjectRoot: "." },
    policyBytes,
  );
}

test("accepts a complete managed audit record", () => {
  assert.equal(validate(fixture()).verdict, "pass");
});

test("rejects local, stale-run, and malformed-timing evidence", () => {
  const local = fixture();
  local.producer = { kind: "local" };
  assert.throws(() => validate(seal(local)), /local evidence/);

  const wrongRun = fixture();
  wrongRun.producer.runId = "999";
  assert.throws(() => validate(seal(wrongRun)), /producer identity/);

  const badTiming = fixture();
  badTiming.steps[0].durationMs = -1;
  assert.throws(() => validate(seal(badTiming)), /invalid duration/);
});

test("rejects failed workflows, moved heads, and non-owner trust changes", () => {
  const failed = structuredClone(gate);
  failed.workflow.conclusion = "failure";
  assert.throws(() => validate(fixture(), request, failed), /did not succeed/);

  const moved = structuredClone(gate);
  moved.pr.head.sha = "0".repeat(40);
  assert.throws(() => validate(fixture(), request, moved), /head moved/);

  const trustRequest = structuredClone(request);
  const trustGate = structuredClone(gate);
  trustRequest.trustBoundary = true;
  trustRequest.actor = "third-party";
  trustRequest.workflow.actor = "third-party";
  trustGate.workflow.actor = "third-party";
  assert.throws(
    () => validate(fixture(), trustRequest, trustGate),
    /not allowlisted/,
  );
});

test("rejects source, step, configuration, record, and root tampering", () => {
  const source = fixture();
  source.source.repository = "attacker/fork";
  assert.throws(() => validate(seal(source)), /source identity/);

  const reordered = fixture();
  reordered.steps.reverse();
  assert.throws(() => validate(seal(reordered)), /steps do not match/);

  const configuration = fixture();
  configuration.configuration.files["package.json"] = "0".repeat(64);
  assert.throws(
    () => validate(seal(configuration)),
    /configuration does not match/,
  );

  const recordSize = fixture();
  recordSize.steps[0].records[0].size += 1;
  assert.throws(() => validate(seal(recordSize)), /record size mismatch/);

  const future = fixture();
  future.createdAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  assert.throws(() => validate(seal(future)), /future/);

  const root = fixture();
  root.evidenceRootSha256 = "0".repeat(64);
  assert.throws(() => validate(root), /root checksum/);
});
