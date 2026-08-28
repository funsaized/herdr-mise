import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const workflowDirectory = ".github/workflows";
const workflows = Object.fromEntries(
  readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => [
      name,
      readFileSync(`${workflowDirectory}/${name}`, "utf8"),
    ]),
);
const dependabot = readFileSync(".github/dependabot.yml", "utf8");
const gitleaks = readFileSync(".gitleaks.toml", "utf8");
const localVerification = readFileSync(
  "workflows/workflow-local-verification.yaml",
  "utf8",
);
const sourceGitModel = readFileSync(
  "models/@swamp/git/verification-source-git.yaml",
  "utf8",
);
const gitAncestryExtension = readFileSync(
  "extensions/models/git_ancestry.ts",
  "utf8",
);
const verificationPolicy = JSON.parse(
  readFileSync("verification/policy.json", "utf8"),
);

function localStepBlock(name) {
  const marker = `      - name: ${name}\n`;
  const start = localVerification.indexOf(marker);
  if (start < 0) return "";
  const end = localVerification.indexOf(
    "\n      - name:",
    start + marker.length,
  );
  return localVerification.slice(start, end < 0 ? undefined : end);
}

function permissionMap(block, indent) {
  const marker = `${" ".repeat(indent)}permissions:\n`;
  const start = block.indexOf(marker);
  if (start < 0) return null;
  const lines = block.slice(start + marker.length).split("\n");
  const entries = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(
      new RegExp(`^ {${indent + 2}}([a-z-]+): (read|write|none)$`),
    );
    if (!match) break;
    entries[match[1]] = match[2];
  }
  return entries;
}

function jobBlocks(source) {
  const jobsStart = source.indexOf("\njobs:\n");
  if (jobsStart < 0) return {};
  const jobs = {};
  const tail = source.slice(jobsStart + 7);
  const matches = [...tail.matchAll(/^  ([a-zA-Z0-9_-]+):\n/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const end = matches[index + 1]?.index ?? tail.length;
    jobs[current[1]] = tail.slice(current.index, end);
  }
  return jobs;
}

function samePermissions(actual, expected) {
  return actual !== null && JSON.stringify(actual) === JSON.stringify(expected);
}

export function auditWorkflowContract(
  candidateWorkflows,
  candidateDependabot,
  candidateGitleaks,
) {
  const errors = [];
  const names = Object.keys(candidateWorkflows).sort();

  for (const [name, source] of Object.entries(candidateWorkflows)) {
    for (const [lineIndex, line] of source.split("\n").entries()) {
      const uses = line.match(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+(#.*))?$/);
      if (!uses || uses[1].startsWith("./")) continue;
      const reference = uses[1].match(/^([^@]+)@(.+)$/);
      if (!reference || !/^[0-9a-f]{40}$/.test(reference[2])) {
        errors.push(
          `${name}:${lineIndex + 1}: external action is not pinned to a full SHA`,
        );
      }
      if (!uses[2] || !/^#\s*\S+/.test(uses[2])) {
        errors.push(
          `${name}:${lineIndex + 1}: pinned action lacks a readable version comment`,
        );
      }
    }
    if (/^\s*pull_request_target:/m.test(source))
      errors.push(`${name}: pull_request_target is forbidden`);

    const topPermissions = permissionMap(source, 0);
    if (!samePermissions(topPermissions, { contents: "read" })) {
      errors.push(
        `${name}: top-level permissions must be exactly contents: read`,
      );
    }

    const jobs = jobBlocks(source);
    for (const [jobName, block] of Object.entries(jobs)) {
      if (
        name !== "release.yml" &&
        !/^    timeout-minutes: [1-9][0-9]*$/m.test(block)
      ) {
        errors.push(`${name}/${jobName}: timeout-minutes is required`);
      }
      const permissions = permissionMap(block, 4);
      if (permissions === null) continue;
      const allowed =
        name === "release.yml" && jobName === "publish"
          ? { contents: "write" }
          : name === "codeql.yml" && jobName === "analyze"
            ? { actions: "read", contents: "read", "security-events": "write" }
            : name === "gitleaks.yml" && jobName === "scan"
              ? { contents: "read", "pull-requests": "read" }
              : null;
      if (!allowed || !samePermissions(permissions, allowed)) {
        errors.push(`${name}/${jobName}: job permissions exceed the contract`);
      }
    }

    if (name !== "release.yml") {
      if (
        !/^concurrency:\n  group: .+\n  cancel-in-progress: true$/m.test(source)
      ) {
        errors.push(`${name}: cancellable concurrency is required`);
      }
    }
  }

  for (const required of [
    "ci.yml",
    "codeql.yml",
    "dependency-review.yml",
    "gitleaks.yml",
    "herdr-compatibility-drift.yml",
    "release.yml",
  ]) {
    if (!names.includes(required))
      errors.push(`${required}: required workflow is missing`);
  }

  const ci = candidateWorkflows["ci.yml"] ?? "";
  const ciJobs = jobBlocks(ci);
  const evidence = ciJobs.evidence ?? "";
  if (
    !/^      - run: node scripts\/verification-evidence\.mjs$/m.test(
      evidence,
    ) ||
    !/^          ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m.test(
      evidence,
    ) ||
    !/^          ref: ops\/evidence$/m.test(evidence) ||
    !/^          path: \.verification-evidence$/m.test(evidence) ||
    (evidence.match(/^          persist-credentials: false$/gm) ?? []).length <
      2 ||
    !/^          VERIFICATION_SOURCE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m.test(
      evidence,
    )
  ) {
    errors.push("ci.yml: exact local verification evidence gate is missing");
  }
  const evidenceConditions = evidence.match(/^    if: .+$/gm) ?? [];
  if (
    JSON.stringify(evidenceConditions) !==
    JSON.stringify([
      "    if: github.event_name == 'pull_request' || github.ref != 'refs/heads/main'",
    ])
  ) {
    errors.push(
      "ci.yml: evidence gate must run on pull requests and non-main pushes only",
    );
  }
  if (/^ {4,}continue-on-error:/m.test(evidence)) {
    errors.push("ci.yml: evidence gate must remain blocking");
  }
  if (!/^  push:\n    branches-ignore:\n      - ops\/evidence$/m.test(ci)) {
    errors.push("ci.yml: evidence branch push exclusion is missing");
  }
  const shadow = ciJobs["verify-shadow"] ?? "";
  if (!shadow) errors.push("ci.yml: shadow full verification job is missing");
  if (/^ {4,}(?:if|continue-on-error):/m.test(shadow)) {
    errors.push(
      "ci.yml: shadow verification must run unconditionally and block during migration",
    );
  }
  if (!ci.includes("cargo install cargo-audit --version 0.22.2 --locked"))
    errors.push("ci.yml: pinned cargo-audit install is missing");
  if (!ci.includes("cargo audit --file Cargo.lock --deny warnings"))
    errors.push("ci.yml: fail-closed Cargo.lock audit is missing");
  if (!ci.includes("npm ci") || !ci.includes("npm ci --prefix client"))
    errors.push("ci.yml: npm lockfile installs are missing");
  for (const line of ci
    .split("\n")
    .filter((line) => /cargo (test|check|build)\b/.test(line))) {
    if (!line.includes("--locked"))
      errors.push("ci.yml: Cargo build/check/test must use --locked");
  }

  const codeql = candidateWorkflows["codeql.yml"] ?? "";
  for (const matrixEntry of [
    "- language: javascript-typescript\n            build-mode: none",
    "- language: rust\n            build-mode: none",
  ]) {
    if (!codeql.includes(matrixEntry))
      errors.push(
        `codeql.yml: missing matrix entry ${matrixEntry.split("\n")[0]}`,
      );
  }
  for (const action of [
    "github/codeql-action/init@",
    "github/codeql-action/analyze@",
  ]) {
    if (!codeql.includes(action)) errors.push(`codeql.yml: missing ${action}`);
  }

  const dependencyReview = candidateWorkflows["dependency-review.yml"] ?? "";
  if (
    !/^  pull_request:$/m.test(dependencyReview) ||
    /pull-requests:\s*write/.test(dependencyReview)
  ) {
    errors.push(
      "dependency-review.yml: review must be read-only on pull_request",
    );
  }
  if (
    !dependencyReview.includes("actions/dependency-review-action@") ||
    !dependencyReview.includes("fail-on-severity: moderate")
  ) {
    errors.push("dependency-review.yml: moderate dependency policy is missing");
  }

  const leaks = candidateWorkflows["gitleaks.yml"] ?? "";
  if (!/^  push:$/m.test(leaks) || !/^  pull_request:$/m.test(leaks))
    errors.push("gitleaks.yml: push and pull_request triggers are required");
  const leakScanPermissions = permissionMap(jobBlocks(leaks).scan ?? "", 4);
  if (
    !samePermissions(leakScanPermissions, {
      contents: "read",
      "pull-requests": "read",
    })
  ) {
    errors.push(
      "gitleaks.yml/scan: job permissions must be exactly contents: read and pull-requests: read",
    );
  }
  if (
    !leaks.includes("fetch-depth: 0") ||
    !leaks.includes("GITLEAKS_CONFIG: ${{ github.workspace }}/.gitleaks.toml")
  ) {
    errors.push(
      "gitleaks.yml: event-range checkout and repository config are required",
    );
  }
  if (!leaks.includes("GITHUB_TOKEN: ${{ github.token }}"))
    errors.push("gitleaks.yml: GitHub token env is required");
  if (!leaks.includes('GITLEAKS_VERSION: "8.30.1"'))
    errors.push("gitleaks.yml: hosted CLI must be pinned to 8.30.1");
  if (!leaks.includes('GITLEAKS_ENABLE_COMMENTS: "false"'))
    errors.push("gitleaks.yml: PR comments must be disabled");

  const release = candidateWorkflows["release.yml"] ?? "";
  if (
    !release.includes("push:\n    tags: ['v*']") ||
    !/publish:\n    if: >-[\s\S]{0,300}startsWith\(github\.ref, 'refs\/tags\/'\)/.test(
      release,
    )
  ) {
    errors.push("release.yml: publication must remain tag-only");
  }
  if (
    !release.includes(
      "concurrency:\n  group: release-${{ github.ref }}\n  cancel-in-progress: false",
    )
  ) {
    errors.push("release.yml: release cancellation must remain disabled");
  }
  for (const secretStep of [
    "Import Developer ID certificate",
    "Notarize signed CLI binary",
  ]) {
    const step = release.slice(release.indexOf(`- name: ${secretStep}`));
    const boundary = step.search(/\n      - (?:name|uses):/);
    const block = boundary < 0 ? step : step.slice(0, boundary);
    if (
      !block.includes(
        "if: startsWith(github.ref, 'refs/tags/') && runner.os == 'macOS'",
      ) ||
      !block.includes("secrets.")
    ) {
      errors.push(`release.yml: ${secretStep} must remain tag-gated`);
    }
  }

  if (
    !/package-ecosystem: github-actions\n    directory: \/\n    schedule:\n      interval: weekly/.test(
      candidateDependabot,
    )
  ) {
    errors.push("dependabot: weekly github-actions updates are required");
  }
  if (
    !candidateGitleaks.includes("useDefault = true") ||
    !candidateGitleaks.includes('condition = "AND"') ||
    !candidateGitleaks.includes("paths = ['''^server/src/service\\.rs$''']") ||
    !candidateGitleaks.includes("regexes = ['''dGhlIHNhbXBsZSBub25jZQ==''']")
  ) {
    errors.push("gitleaks config: narrow RFC 6455 allowlist changed");
  }

  return errors;
}

function mutateWorkflow(name, transform) {
  return { ...workflows, [name]: transform(workflows[name]) };
}

test("repository workflows satisfy the supply-chain contract", () => {
  assert.deepEqual(auditWorkflowContract(workflows, dependabot, gitleaks), []);
});

test("local verification requires the current remote main ancestor", () => {
  assert.match(localStepBlock("fetch-source"), /methodName: fetch/);
  assert.match(localStepBlock("lookup-remote-main"), /methodName: remote_ref/);
  assert.match(localStepBlock("lookup-remote-main"), /step: fetch-source/);
  assert.match(localStepBlock("lookup-remote-main"), /ref: refs\/heads\/main/);
  assert.match(
    localStepBlock("require-main-ancestor"),
    /methodName: require_ancestor/,
  );
  assert.match(
    localStepBlock("require-main-ancestor"),
    /data\.latest\("verification-source-git", "remote-ref-refs-heads-main"\)\.attributes\.sha/,
  );
  assert.match(
    localStepBlock("dependencies-root"),
    /step: require-main-ancestor/,
  );
  assert.deepEqual(
    verificationPolicy.steps.slice(0, 3).map((step) => step.name),
    ["fetch-source", "lookup-remote-main", "require-main-ancestor"],
  );
  assert.match(sourceGitModel, /repoPath: \./);
  assert.match(gitAncestryExtension, /type: "@swamp\/git"/);
});

test("contract rejects mutable refs and missing readable pin comments", () => {
  const mutable = mutateWorkflow("ci.yml", (source) =>
    source.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v7"),
  );
  const uncommented = mutateWorkflow("ci.yml", (source) =>
    source.replace(/(actions\/checkout@[0-9a-f]{40}) # v7\.0\.1/, "$1"),
  );
  assert.ok(
    auditWorkflowContract(mutable, dependabot, gitleaks).some((error) =>
      error.includes("not pinned"),
    ),
  );
  assert.ok(
    auditWorkflowContract(uncommented, dependabot, gitleaks).some((error) =>
      error.includes("version comment"),
    ),
  );
});

test("contract rejects privileged PR triggers and broadened permissions", () => {
  const trigger = mutateWorkflow("gitleaks.yml", (source) =>
    source.replace("  pull_request:", "  pull_request_target:"),
  );
  const permission = mutateWorkflow("dependency-review.yml", (source) =>
    source.replace(
      "  contents: read",
      "  contents: read\n  pull-requests: write",
    ),
  );
  assert.ok(
    auditWorkflowContract(trigger, dependabot, gitleaks).some((error) =>
      error.includes("pull_request_target"),
    ),
  );
  assert.ok(
    auditWorkflowContract(permission, dependabot, gitleaks).some((error) =>
      error.includes("top-level permissions"),
    ),
  );
});

test("contract rejects missing non-release controls and weakened scanner configuration", () => {
  const timeout = mutateWorkflow("codeql.yml", (source) =>
    source.replace("    timeout-minutes: 30\n", ""),
  );
  const concurrency = mutateWorkflow("ci.yml", (source) =>
    source.replace("  cancel-in-progress: true", "  cancel-in-progress: false"),
  );
  const config = mutateWorkflow("gitleaks.yml", (source) =>
    source.replace("/.gitleaks.toml", "/gitleaks.toml"),
  );
  const noEvidence = mutateWorkflow("ci.yml", (source) =>
    source.replace("node scripts/verification-evidence.mjs", "true"),
  );
  const nonBlockingShadow = mutateWorkflow("ci.yml", (source) =>
    source.replace(
      "  verify-shadow:\n",
      "  verify-shadow:\n    continue-on-error: true\n",
    ),
  );
  assert.ok(
    auditWorkflowContract(timeout, dependabot, gitleaks).some((error) =>
      error.includes("timeout-minutes"),
    ),
  );
  assert.ok(
    auditWorkflowContract(concurrency, dependabot, gitleaks).some((error) =>
      error.includes("cancellable concurrency"),
    ),
  );
  assert.ok(
    auditWorkflowContract(config, dependabot, gitleaks).some((error) =>
      error.includes("repository config"),
    ),
  );
  assert.ok(
    auditWorkflowContract(noEvidence, dependabot, gitleaks).some((error) =>
      error.includes("evidence gate"),
    ),
  );
  assert.ok(
    auditWorkflowContract(nonBlockingShadow, dependabot, gitleaks).some(
      (error) => error.includes("shadow verification"),
    ),
  );
});

test("contract rejects incorrect evidence and shadow job conditions", () => {
  const conditionalEvidence = mutateWorkflow("ci.yml", (source) =>
    source.replace("  evidence:\n", "  evidence:\n    if: false\n"),
  );
  const conditionalShadow = mutateWorkflow("ci.yml", (source) =>
    source.replace(
      "  verify-shadow:\n",
      "  verify-shadow:\n    if: ${{ false }}\n",
    ),
  );
  const toleratedEvidenceFailure = mutateWorkflow("ci.yml", (source) =>
    source.replace(
      "      - run: node scripts/verification-evidence.mjs\n",
      "      - run: node scripts/verification-evidence.mjs\n        continue-on-error: yes\n",
    ),
  );

  for (const candidate of [
    conditionalEvidence,
    conditionalShadow,
    toleratedEvidenceFailure,
  ]) {
    assert.ok(
      auditWorkflowContract(candidate, dependabot, gitleaks).some((error) =>
        /unconditional|must run|remain blocking/.test(error),
      ),
    );
  }
});

test("contract requires the exact fork-safe Gitleaks job contract", () => {
  const noPermissions = mutateWorkflow("gitleaks.yml", (source) =>
    source.replace(
      "    permissions:\n      contents: read\n      pull-requests: read\n",
      "",
    ),
  );
  const broadPermissions = mutateWorkflow("gitleaks.yml", (source) =>
    source.replace(
      "      pull-requests: read",
      "      pull-requests: read\n      issues: write",
    ),
  );
  const noToken = mutateWorkflow("gitleaks.yml", (source) =>
    source.replace("          GITHUB_TOKEN: ${{ github.token }}\n", ""),
  );
  const noVersion = mutateWorkflow("gitleaks.yml", (source) =>
    source.replace('          GITLEAKS_VERSION: "8.30.1"\n', ""),
  );
  const noConfig = mutateWorkflow("gitleaks.yml", (source) =>
    source.replace(
      "          GITLEAKS_CONFIG: ${{ github.workspace }}/.gitleaks.toml\n",
      "",
    ),
  );
  const comments = mutateWorkflow("gitleaks.yml", (source) =>
    source.replace(
      'GITLEAKS_ENABLE_COMMENTS: "false"',
      'GITLEAKS_ENABLE_COMMENTS: "true"',
    ),
  );
  const shallowCheckout = mutateWorkflow("gitleaks.yml", (source) =>
    source.replace("fetch-depth: 0", "fetch-depth: 1"),
  );

  assert.ok(
    auditWorkflowContract(noPermissions, dependabot, gitleaks).some((error) =>
      error.includes("job permissions must be exactly"),
    ),
  );
  assert.ok(
    auditWorkflowContract(broadPermissions, dependabot, gitleaks).some(
      (error) => error.includes("job permissions"),
    ),
  );
  assert.ok(
    auditWorkflowContract(noToken, dependabot, gitleaks).some((error) =>
      error.includes("GitHub token env"),
    ),
  );
  assert.ok(
    auditWorkflowContract(noVersion, dependabot, gitleaks).some((error) =>
      error.includes("hosted CLI"),
    ),
  );
  assert.ok(
    auditWorkflowContract(noConfig, dependabot, gitleaks).some((error) =>
      error.includes("repository config"),
    ),
  );
  assert.ok(
    auditWorkflowContract(comments, dependabot, gitleaks).some((error) =>
      error.includes("comments must be disabled"),
    ),
  );
  assert.ok(
    auditWorkflowContract(shallowCheckout, dependabot, gitleaks).some((error) =>
      error.includes("event-range checkout"),
    ),
  );
});

test("contract rejects advisory, lockfile, CodeQL, and dependency-policy weakening", () => {
  const audit = mutateWorkflow("ci.yml", (source) =>
    source.replace("--version 0.22.2 --locked", "--version 0.22.3"),
  );
  const cargoLock = mutateWorkflow("ci.yml", (source) =>
    source.replace(
      "cargo check --workspace --locked",
      "cargo check --workspace",
    ),
  );
  const codeql = mutateWorkflow("codeql.yml", (source) =>
    source.replace("language: rust", "language: go"),
  );
  const dependency = mutateWorkflow("dependency-review.yml", (source) =>
    source.replace("fail-on-severity: moderate", "fail-on-severity: critical"),
  );
  assert.ok(
    auditWorkflowContract(audit, dependabot, gitleaks).some((error) =>
      error.includes("pinned cargo-audit"),
    ),
  );
  assert.ok(
    auditWorkflowContract(cargoLock, dependabot, gitleaks).some((error) =>
      error.includes("must use --locked"),
    ),
  );
  assert.ok(
    auditWorkflowContract(codeql, dependabot, gitleaks).some((error) =>
      error.includes("language: rust"),
    ),
  );
  assert.ok(
    auditWorkflowContract(dependency, dependabot, gitleaks).some((error) =>
      error.includes("moderate dependency policy"),
    ),
  );
});

test("contract rejects release publication, cancellation, and signing-gate weakening", () => {
  const publication = mutateWorkflow("release.yml", (source) =>
    source.replace("startsWith(github.ref, 'refs/tags/') &&\n", "true &&\n"),
  );
  const cancellation = mutateWorkflow("release.yml", (source) =>
    source.replace("cancel-in-progress: false", "cancel-in-progress: true"),
  );
  const signing = mutateWorkflow("release.yml", (source) =>
    source.replace(
      "if: startsWith(github.ref, 'refs/tags/') && runner.os == 'macOS'",
      "if: runner.os == 'macOS'",
    ),
  );
  assert.ok(
    auditWorkflowContract(publication, dependabot, gitleaks).some((error) =>
      error.includes("tag-only"),
    ),
  );
  assert.ok(
    auditWorkflowContract(cancellation, dependabot, gitleaks).some((error) =>
      error.includes("cancellation"),
    ),
  );
  assert.ok(
    auditWorkflowContract(signing, dependabot, gitleaks).some((error) =>
      error.includes("tag-gated"),
    ),
  );
});

test("contract rejects maintenance and narrow allowlist drift", () => {
  const noActions = dependabot.replace(
    "package-ecosystem: github-actions",
    "package-ecosystem: docker",
  );
  const broadAllowlist = gitleaks.replace(
    'condition = "AND"',
    'condition = "OR"',
  );
  assert.ok(
    auditWorkflowContract(workflows, noActions, gitleaks).some((error) =>
      error.includes("weekly github-actions"),
    ),
  );
  assert.ok(
    auditWorkflowContract(workflows, dependabot, broadAllowlist).some((error) =>
      error.includes("narrow RFC 6455"),
    ),
  );
});
