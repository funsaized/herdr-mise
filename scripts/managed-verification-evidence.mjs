import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const maxManifestBytes = 2 * 1024 * 1024;
const digestPattern = /^[0-9a-f]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

function inside(root, path) {
  const absolute = resolve(root, path);
  const child = relative(root, absolute);
  assert(
    !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`),
    `path escapes root: ${path}`,
  );
  return absolute;
}

function regularRoot(path, name) {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  assert(
    info.isDirectory() && !info.isSymbolicLink(),
    `${name} is not a directory`,
  );
  return realpathSync(absolute);
}

function readRegular(root, path) {
  const absolute = inside(root, path);
  const info = lstatSync(absolute);
  assert(
    info.isFile() && !info.isSymbolicLink(),
    `${path} is not a regular file`,
  );
  const real = realpathSync(absolute);
  const child = relative(root, real);
  assert(
    !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`),
    `${path} resolves outside root`,
  );
  return readFileSync(real);
}

function git(root, args) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    },
  ).trim();
}

function decodeRecord(step, record) {
  assert(record && typeof record === "object", `${step}: invalid record`);
  assert(digestPattern.test(record.sha256), `${step}: bad record digest`);
  assert(
    Number.isInteger(record.size) && record.size >= 0,
    `${step}: bad record size`,
  );
  assert(
    typeof record.contentBase64 === "string",
    `${step}: record content is missing`,
  );
  const content = Buffer.from(record.contentBase64, "base64");
  assert(
    content.toString("base64") === record.contentBase64,
    `${step}: invalid base64 record`,
  );
  assert(content.length === record.size, `${step}: record size mismatch`);
  assert(
    sha256(content) === record.sha256,
    `${step}: record checksum mismatch`,
  );
  return content;
}

function validateTiming(name, step, value) {
  const started = Date.parse(step.startedAt);
  const completed = Date.parse(step.completedAt);
  assert(
    Number.isFinite(started) && Number.isFinite(completed),
    `${name}: invalid timestamp`,
  );
  assert(completed >= started, `${name}: completion precedes start`);
  assert(
    Number.isInteger(step.durationMs) && step.durationMs >= 0,
    `${name}: invalid duration`,
  );
  assert(
    Math.abs(completed - started - step.durationMs) <= 1000,
    `${name}: duration mismatch`,
  );
  assert(
    value.startedAt === step.startedAt &&
      value.completedAt === step.completedAt &&
      value.durationMs === step.durationMs,
    `${name}: timing does not match trusted model output`,
  );
}

function validateStep(policyStep, step, sourceRoot, commit, baseCommit, tree) {
  assert(
    step.status === "succeeded" &&
      step.modelName === policyStep.modelName &&
      step.modelType === policyStep.modelType &&
      step.method === policyStep.method,
    `${policyStep.name}: execution identity or status does not match`,
  );
  assert(
    Array.isArray(step.records),
    `${policyStep.name}: records are missing`,
  );
  const specs = step.records.map((record) => record.specName).sort();
  assert(
    JSON.stringify(specs) === JSON.stringify([...policyStep.outputs].sort()),
    `${policyStep.name}: output set does not match`,
  );
  const decoded = new Map();
  for (const record of step.records) {
    const content = decodeRecord(policyStep.name, record);
    if (record.specName !== "log") {
      assert(
        !decoded.has(record.specName),
        `${policyStep.name}: duplicate record`,
      );
      decoded.set(record.specName, JSON.parse(content));
    }
  }
  const result = policyStep.modelType.includes("npm")
    ? decoded.get("invocation")
    : policyStep.modelType === "@swamp/git"
      ? decoded.get("subjectResult")
      : decoded.get("result");
  assert(result, `${policyStep.name}: structured result is missing`);
  validateTiming(policyStep.name, step, result);
  if (policyStep.modelType === "@swamp/git") {
    assert(
      result.commit === commit &&
        result.tree === tree &&
        result.baseCommit === baseCommit &&
        result.clean === true,
      `${policyStep.name}: source preflight does not match`,
    );
  } else if (policyStep.modelType.includes("npm")) {
    assert(
      result.operation === policyStep.operation &&
        result.projectDir === policyStep.projectDir &&
        JSON.stringify(result.argv) === JSON.stringify(policyStep.argv) &&
        result.executionStatus === "succeeded" &&
        result.exitCode === 0,
      `${policyStep.name}: npm invocation does not match policy`,
    );
    assert(
      result.expectedGitHead === commit &&
        result.gitHeadBefore === commit &&
        result.gitHeadAfter === commit &&
        result.cleanWorktreeBefore === true &&
        result.cleanWorktreeAfter === true,
      `${policyStep.name}: npm invocation is not bound to the subject`,
    );
    assert(
      result.packageJsonSha256Before === result.packageJsonSha256After &&
        result.lockfileSha256Before === result.lockfileSha256After &&
        result.lockfilePath === "package-lock.json",
      `${policyStep.name}: npm metadata changed`,
    );
    const projectDir = policyStep.projectDir ?? ".";
    assert(
      result.packageJsonSha256Before ===
        sha256(readRegular(sourceRoot, join(projectDir, "package.json"))) &&
        result.lockfileSha256Before ===
          sha256(
            readRegular(sourceRoot, join(projectDir, "package-lock.json")),
          ),
      `${policyStep.name}: npm metadata does not match the subject`,
    );
  } else {
    assert(
      result.status === "passed" && result.gitHead === commit,
      `${policyStep.name}: Rust result failed`,
    );
    assert(
      Array.isArray(result.checks) &&
        result.checks.every((check) => check.status === "passed") &&
        JSON.stringify(result.checks.map((check) => check.name)) ===
          JSON.stringify(policyStep.checks),
      `${policyStep.name}: Rust checks do not match policy`,
    );
    assert(
      result.cargoLockSha256 === sha256(readRegular(sourceRoot, "Cargo.lock")),
      `${policyStep.name}: Cargo.lock does not match the subject`,
    );
  }
}

function validateArtifacts(manifest, policy, sourceRoot) {
  assert(Array.isArray(manifest.artifacts), "artifact evidence is missing");
  assert(
    JSON.stringify(manifest.artifacts.map((artifact) => artifact.path)) ===
      JSON.stringify(policy.artifacts),
    "artifact roots do not match policy",
  );
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    inside(sourceRoot, artifact.path);
    assert(
      Array.isArray(artifact.files) && artifact.files.length > 0,
      `${artifact.path}: no files`,
    );
    let previous = "";
    for (const file of artifact.files) {
      assert(
        typeof file.path === "string" && file.path > previous,
        `${artifact.path}: files are not sorted`,
      );
      previous = file.path;
      assert(!seen.has(file.path), `duplicate artifact file: ${file.path}`);
      seen.add(file.path);
      inside(sourceRoot, file.path);
      assert(
        file.path === artifact.path ||
          file.path.startsWith(`${artifact.path}/`),
        `${file.path}: outside artifact root`,
      );
      assert(
        Number.isInteger(file.size) && file.size >= 0,
        `${file.path}: invalid size`,
      );
      assert(
        typeof file.executable === "boolean",
        `${file.path}: executable bit is missing`,
      );
      assert(digestPattern.test(file.sha256), `${file.path}: invalid digest`);
    }
  }
}

export function validateManagedEvidenceManifest(
  manifest,
  policy,
  request,
  gate,
  roots,
  policyBytes,
  now = Date.now(),
) {
  const policyRoot = regularRoot(roots.policyRoot, "policy root");
  const sourceRoot = regularRoot(roots.subjectRoot, "subject root");
  assert(manifest.schemaVersion === 2, "unsupported managed evidence schema");
  assert(
    manifest.verdict === "pass",
    "managed verification verdict is not pass",
  );
  assert(request.schemaVersion === 1, "unsupported managed request schema");
  assert(gate.schemaVersion === 1, "unsupported managed gate context schema");
  assert(
    gate.workflow.conclusion === "success",
    "managed workflow did not succeed",
  );
  assert(
    gate.workflow.event === "workflow_dispatch" &&
      gate.workflow.headBranch === "main",
    "managed workflow identity is invalid",
  );
  assert(
    request.repository === policy.producer.repository &&
      gate.repository === policy.producer.repository &&
      request.workflow.path === policy.producer.workflowPath &&
      gate.workflow.path === policy.producer.workflowPath &&
      request.workflow.ref === policy.producer.workflowRef &&
      gate.workflow.ref === policy.producer.workflowRef,
    "managed workflow path or ref does not match policy",
  );
  for (const field of ["id", "runId", "runAttempt", "actor"]) {
    assert(
      String(request.workflow[field]) === String(gate.workflow[field]),
      `managed workflow ${field} does not match`,
    );
  }
  assert(
    request.controlSha === gate.workflow.headSha,
    "trusted control SHA does not match run",
  );
  assert(
    request.actor === gate.workflow.actor,
    "dispatcher does not match triggering actor",
  );
  assert(
    request.prNumber === gate.pr.number && gate.pr.state === "open",
    "pull request identity is invalid",
  );
  assert(
    request.head.repository === gate.pr.head.repository &&
      String(request.head.repositoryId) === String(gate.pr.head.repositoryId) &&
      request.head.sha === gate.pr.head.sha,
    "pull request head moved",
  );
  assert(
    request.base.repository === policy.producer.repository &&
      request.base.repository === gate.pr.base.repository &&
      request.base.branch === "main" &&
      gate.pr.base.branch === "main" &&
      request.base.sha === gate.pr.base.sha &&
      request.base.sha === gate.currentMainSha,
    "pull request base moved",
  );
  if (request.trustBoundary) {
    assert(
      policy.producer.codeOwners.includes(request.actor),
      "trust-boundary dispatcher is not allowlisted",
    );
  }

  const commit = git(sourceRoot, ["rev-parse", "HEAD"]);
  const tree = git(sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  const controlCommit = git(policyRoot, ["rev-parse", "HEAD"]);
  assert(
    commit === request.head.sha,
    "checked-out subject does not match request",
  );
  assert(
    controlCommit === request.controlSha,
    "checked-out control does not match request",
  );
  assert(
    manifest.source?.repository === request.head.repository &&
      String(manifest.source?.repositoryId) ===
        String(request.head.repositoryId) &&
      manifest.source?.commit === commit &&
      manifest.source?.tree === tree,
    "attested source identity does not match",
  );
  assert(
    manifest.base?.repository === request.base.repository &&
      manifest.base?.branch === "main" &&
      manifest.base?.commit === request.base.sha,
    "attested base identity does not match",
  );
  const workflowBytes = readRegular(policyRoot, policy.workflow.path);
  const pinnedVersion = readRegular(policyRoot, ".swamp.yaml")
    .toString()
    .match(/^swampVersion:\s*(\S+)/m)?.[1];
  assert(
    manifest.control?.repository === request.repository &&
      manifest.control?.commit === request.controlSha &&
      manifest.control?.policySha256 === sha256(policyBytes) &&
      manifest.control?.workflowSha256 === sha256(workflowBytes) &&
      typeof pinnedVersion === "string" &&
      manifest.control?.swampVersion.startsWith(pinnedVersion),
    "attested control identity does not match",
  );
  assert(
    manifest.producer?.kind === "github-actions",
    "local evidence is not managed evidence",
  );
  assert(
    manifest.producer.githubRepository === request.repository &&
      manifest.producer.workflowPath === request.workflow.path &&
      manifest.producer.workflowRef === request.workflow.ref &&
      String(manifest.producer.workflowId) === String(gate.workflow.id) &&
      String(manifest.producer.runId) === String(gate.workflow.runId) &&
      String(manifest.producer.runAttempt) ===
        String(gate.workflow.runAttempt) &&
      manifest.producer.dispatchActor === gate.workflow.actor,
    "managed producer identity does not match",
  );
  assert(
    manifest.workflow?.id === policy.workflow.id &&
      manifest.workflow?.name === policy.workflow.name &&
      /^[0-9a-f-]{36}$/.test(manifest.workflow?.runId),
    "Swamp workflow identity does not match policy",
  );

  const createdAt = Date.parse(manifest.createdAt);
  const age = now - createdAt;
  assert(Number.isFinite(createdAt), "createdAt is invalid");
  assert(age >= -5 * 60 * 1000, "managed evidence timestamp is in the future");
  assert(
    age <= policy.maxAgeHours * 60 * 60 * 1000,
    "managed evidence is stale",
  );
  const expectedConfiguration = Object.fromEntries(
    [...policy.configurationFiles]
      .sort()
      .map((path) => [path, sha256(readRegular(policyRoot, path))]),
  );
  assert(
    manifest.configuration?.algorithm === "sha256",
    "unsupported configuration digest",
  );
  assert(
    JSON.stringify(manifest.configuration.files) ===
      JSON.stringify(expectedConfiguration),
    "managed verification configuration does not match",
  );
  assert(Array.isArray(manifest.steps), "managed step evidence is missing");
  assert(
    JSON.stringify(manifest.steps.map((step) => step.name)) ===
      JSON.stringify(policy.steps.map((step) => step.name)),
    "managed verification steps do not match policy",
  );
  for (let index = 0; index < policy.steps.length; index += 1) {
    validateStep(
      policy.steps[index],
      manifest.steps[index],
      sourceRoot,
      request.head.sha,
      request.base.sha,
      tree,
    );
  }
  validateArtifacts(manifest, policy, sourceRoot);
  const { evidenceRootSha256, ...unsigned } = manifest;
  assert(
    digestPattern.test(evidenceRootSha256),
    "invalid managed evidence root",
  );
  assert(
    sha256(canonical(unsigned)) === evidenceRootSha256,
    "managed evidence root checksum does not match",
  );
  return manifest;
}

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    assert(
      /^--[a-z-]+$/.test(key) && argv[index + 1],
      `invalid argument: ${key ?? "missing"}`,
    );
    values[key.slice(2)] = argv[index + 1];
  }
  for (const name of [
    "policy-root",
    "subject-root",
    "artifact-dir",
    "request",
    "context",
  ]) {
    assert(values[name], `missing --${name}`);
  }
  return values;
}

function boundedJson(path, maxBytes, name) {
  const info = lstatSync(path);
  assert(
    info.isFile() && !info.isSymbolicLink(),
    `${name} is not a regular file`,
  );
  assert(info.size <= maxBytes, `${name} exceeds ${maxBytes} bytes`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const policyRoot = regularRoot(args["policy-root"], "policy root");
  const subjectRoot = regularRoot(args["subject-root"], "subject root");
  const artifactDir = regularRoot(args["artifact-dir"], "artifact directory");
  const policyPath = inside(policyRoot, "verification/managed-policy.json");
  const policyBytes = readFileSync(policyPath);
  const policy = JSON.parse(policyBytes);
  const manifest = boundedJson(
    inside(artifactDir, "manifest.json"),
    maxManifestBytes,
    "manifest",
  );
  const request = boundedJson(resolve(args.request), 128 * 1024, "request");
  const gate = boundedJson(resolve(args.context), 128 * 1024, "gate context");
  validateManagedEvidenceManifest(
    manifest,
    policy,
    request,
    gate,
    { policyRoot, subjectRoot },
    policyBytes,
  );
  console.log(`Validated managed verification for ${manifest.source.commit}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
