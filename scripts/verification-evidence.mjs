import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const policyPath = "verification/policy.json";
const maxManifestBytes = 2 * 1024 * 1024;

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

function inside(directory, path) {
  const absolute = resolve(directory, path);
  const child = relative(directory, absolute);
  assert(
    !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`),
    `path escapes repository: ${path}`,
  );
  return absolute;
}

function readConfiguration(path) {
  const absolute = inside(root, path);
  const info = lstatSync(absolute);
  assert(
    info.isFile() && !info.isSymbolicLink(),
    `${path} is not a regular file`,
  );
  assert(
    realpathSync(absolute).startsWith(`${realpathSync(root)}${sep}`),
    `${path} resolves outside the repository`,
  );
  return readFileSync(absolute);
}

function decodeRecord(step, record) {
  assert(/^[0-9a-f]{64}$/.test(record.sha256), `${step}: bad record digest`);
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

function validateResult(policyStep, records, expectedCommit) {
  const resultSpec = policyStep.modelType.includes("npm")
    ? "invocation"
    : "result";
  const result = records.find((record) => record.specName === resultSpec);
  assert(result, `${policyStep.name}: structured result is missing`);
  const value = JSON.parse(decodeRecord(policyStep.name, result));
  if (resultSpec === "invocation") {
    assert(
      value.operation === policyStep.method &&
        value.projectDir === policyStep.projectDir &&
        JSON.stringify(value.argv) === JSON.stringify(policyStep.argv),
      `${policyStep.name}: npm command does not match policy`,
    );
    assert(
      value.executionStatus === "succeeded" && value.exitCode === 0,
      `${policyStep.name}: npm invocation did not succeed`,
    );
    assert(
      value.expectedGitHead === expectedCommit &&
        value.gitHeadBefore === expectedCommit &&
        value.gitHeadAfter === expectedCommit,
      `${policyStep.name}: invocation is not bound to the source commit`,
    );
    assert(
      value.cleanWorktreeBefore === true && value.cleanWorktreeAfter === true,
      `${policyStep.name}: invocation used a dirty worktree`,
    );
    assert(
      value.packageJsonSha256Before === value.packageJsonSha256After &&
        value.lockfileSha256Before === value.lockfileSha256After,
      `${policyStep.name}: package metadata changed during execution`,
    );
    assert(
      value.lockfilePath === "package-lock.json",
      `${policyStep.name}: unexpected npm lockfile path`,
    );
    const projectDir = policyStep.projectDir ?? ".";
    assert(
      value.packageJsonSha256Before ===
        sha256(readConfiguration(join(projectDir, "package.json"))) &&
        value.lockfileSha256Before ===
          sha256(readConfiguration(join(projectDir, value.lockfilePath))),
      `${policyStep.name}: package metadata does not match the source commit`,
    );
  } else {
    assert(
      value.status === "passed",
      `${policyStep.name}: Rust result did not pass`,
    );
    assert(
      Array.isArray(value.checks) &&
        value.checks.length > 0 &&
        value.checks.every((check) => check.status === "passed"),
      `${policyStep.name}: Rust check did not pass`,
    );
    assert(
      JSON.stringify(value.checks.map((check) => check.name)) ===
        JSON.stringify(policyStep.checks),
      `${policyStep.name}: Rust checks do not match policy`,
    );
    assert(
      value.gitHead === expectedCommit,
      `${policyStep.name}: Rust result is not bound to the source commit`,
    );
    assert(
      value.cargoLockSha256 === sha256(readConfiguration("Cargo.lock")),
      `${policyStep.name}: Rust lockfile does not match the source commit`,
    );
  }
}

function validateArtifacts(manifest, policy) {
  assert(Array.isArray(manifest.artifacts), "artifact evidence is missing");
  assert(
    JSON.stringify(manifest.artifacts.map((artifact) => artifact.path)) ===
      JSON.stringify(policy.artifacts),
    "artifact roots do not match policy",
  );
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    assert(
      Array.isArray(artifact.files) && artifact.files.length > 0,
      `${artifact.path}: no artifact files`,
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
      inside(root, file.path);
      assert(
        file.path === artifact.path ||
          file.path.startsWith(`${artifact.path}/`),
        `${file.path}: artifact path is outside ${artifact.path}`,
      );
      assert(
        Number.isInteger(file.size) && file.size >= 0,
        `${file.path}: invalid size`,
      );
      assert(
        typeof file.executable === "boolean",
        `${file.path}: executable flag is missing`,
      );
      assert(
        /^[0-9a-f]{64}$/.test(file.sha256),
        `${file.path}: invalid digest`,
      );
    }
  }
}

export function validateEvidenceManifest(
  manifest,
  policy,
  expectedCommit,
  now = Date.now(),
) {
  assert(manifest.schemaVersion === 1, "unsupported evidence schema");
  assert(manifest.verdict === "pass", "verification verdict is not pass");
  assert(
    manifest.source?.commit === expectedCommit,
    "evidence names the wrong commit",
  );
  const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert(
    checkedOutCommit === expectedCommit,
    "checked-out source commit does not match CI subject",
  );
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert(manifest.source.tree === tree, "source tree digest does not match");
  assert(
    manifest.workflow?.id === policy.workflow.id &&
      manifest.workflow?.name === policy.workflow.name &&
      /^[0-9a-f-]{36}$/.test(manifest.workflow?.runId),
    "workflow identity does not match policy",
  );

  const createdAt = Date.parse(manifest.createdAt);
  const age = now - createdAt;
  assert(Number.isFinite(createdAt), "createdAt is invalid");
  assert(age >= -5 * 60 * 1000, "evidence timestamp is in the future");
  assert(age <= policy.maxAgeHours * 60 * 60 * 1000, "evidence is stale");

  const expectedConfiguration = Object.fromEntries(
    policy.configurationFiles.map((path) => [
      path,
      sha256(readConfiguration(path)),
    ]),
  );
  assert(
    manifest.configuration?.algorithm === "sha256",
    "unsupported configuration digest",
  );
  assert(
    JSON.stringify(manifest.configuration.files) ===
      JSON.stringify(expectedConfiguration),
    "verification configuration does not match",
  );

  assert(Array.isArray(manifest.steps), "step evidence is missing");
  assert(
    JSON.stringify(manifest.steps.map((step) => step.name)) ===
      JSON.stringify(policy.steps.map((step) => step.name)),
    "verification steps do not match policy",
  );
  for (let index = 0; index < policy.steps.length; index += 1) {
    const expected = policy.steps[index];
    const step = manifest.steps[index];
    assert(
      step.status === "succeeded" &&
        step.modelName === expected.modelName &&
        step.modelType === expected.modelType &&
        step.method === expected.method,
      `${expected.name}: execution identity or status does not match`,
    );
    assert(
      Array.isArray(step.records),
      `${expected.name}: records are missing`,
    );
    const specs = step.records.map((record) => record.specName).sort();
    assert(
      JSON.stringify(specs) === JSON.stringify([...expected.outputs].sort()),
      `${expected.name}: output set does not match`,
    );
    for (const record of step.records) decodeRecord(expected.name, record);
    validateResult(expected, step.records, expectedCommit);
  }
  validateArtifacts(manifest, policy);

  const { evidenceRootSha256, ...unsigned } = manifest;
  assert(/^[0-9a-f]{64}$/.test(evidenceRootSha256), "invalid evidence root");
  assert(
    sha256(canonical(unsigned)) === evidenceRootSha256,
    "evidence root checksum does not match",
  );
  return manifest;
}

function main() {
  process.chdir(root);
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const expectedCommit =
    process.env.VERIFICATION_SOURCE_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert(
    /^[0-9a-f]{40}$/.test(expectedCommit),
    "verification source SHA is invalid",
  );
  const evidenceRoot = resolve(
    process.env.VERIFICATION_EVIDENCE_DIR ?? ".verification-evidence",
  );
  const evidenceInfo = lstatSync(evidenceRoot);
  assert(
    evidenceInfo.isDirectory() && !evidenceInfo.isSymbolicLink(),
    "evidence root is not a regular directory",
  );
  const commitDirectory = inside(evidenceRoot, `evidence/v1/${expectedCommit}`);
  const candidates = readdirSync(commitDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(commitDirectory, entry.name, "manifest.json"))
    .filter((path) => {
      try {
        const info = lstatSync(path);
        return (
          info.isFile() &&
          !info.isSymbolicLink() &&
          info.size <= maxManifestBytes
        );
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
  assert(
    candidates.length > 0,
    `no verification evidence found for ${expectedCommit}`,
  );

  const failures = [];
  for (const path of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      validateEvidenceManifest(manifest, policy, expectedCommit);
      console.log(
        `Validated ${relative(root, path)}: ${manifest.steps.length} steps, ${manifest.artifacts.length} artifact groups`,
      );
      return;
    } catch (error) {
      failures.push(`${relative(root, path)}: ${error.message}`);
    }
  }
  throw new Error(
    `no valid verification evidence for ${expectedCommit}\n${failures.join("\n")}`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
