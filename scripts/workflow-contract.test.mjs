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
const managedVerification = readFileSync(
  "workflows/workflow-verification.yaml",
  "utf8",
);
const managedEvidenceCollector = readFileSync(
  "extensions/models/verification_evidence_managed.ts",
  "utf8",
);
const managedPolicy = JSON.parse(
  readFileSync("verification/managed-policy.json", "utf8"),
);

function permissionMap(block, indent) {
  if (new RegExp(`^ {${indent}}permissions: \\{\\}$`, "m").test(block))
    return {};
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

    const expectedTopPermissions =
      name === "swamp-managed-verification.yml"
        ? {}
        : name === "swamp-managed-gate.yml"
          ? {
              actions: "read",
              contents: "read",
              "pull-requests": "read",
              statuses: "write",
            }
          : { contents: "read" };
    const topPermissions = permissionMap(source, 0);
    if (!samePermissions(topPermissions, expectedTopPermissions)) {
      errors.push(
        `${name}: top-level permissions exceed the workflow contract`,
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
              : name === "swamp-managed-verification.yml" &&
                  jobName === "resolve"
                ? {
                    actions: "read",
                    contents: "read",
                    "pull-requests": "read",
                  }
                : name === "swamp-managed-verification.yml" &&
                    jobName === "execute"
                  ? {}
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
    "swamp-managed-gate.yml",
    "swamp-managed-verification.yml",
  ]) {
    if (!names.includes(required))
      errors.push(`${required}: required workflow is missing`);
  }

  const ci = candidateWorkflows["ci.yml"] ?? "";
  const ciJobs = jobBlocks(ci);
  if (ciJobs.evidence || ciJobs["verify-shadow"]) {
    errors.push("ci.yml: retired evidence or shadow verification job returned");
  }
  if (!/^  push:\n    branches-ignore:\n      - ops\/evidence$/m.test(ci)) {
    errors.push("ci.yml: historical evidence branch push exclusion is missing");
  }
  if (!ci.includes("cargo install cargo-audit --version 0.22.2 --locked"))
    errors.push("ci.yml: pinned cargo-audit install is missing");
  if (!ci.includes("cargo audit --file Cargo.lock --deny warnings"))
    errors.push("ci.yml: fail-closed Cargo.lock audit is missing");

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

  const managed = candidateWorkflows["swamp-managed-verification.yml"] ?? "";
  const managedJobs = jobBlocks(managed);
  if (
    !/^  workflow_dispatch:$/m.test(managed) ||
    /^  (?:push|pull_request|pull_request_target|workflow_run):/m.test(
      managed,
    ) ||
    !/group: swamp-managed-verification-\$\{\{ inputs\.prNumber \}\}/.test(
      managed,
    )
  )
    errors.push(
      "managed executor: exact workflow_dispatch contract is missing",
    );
  if (
    !samePermissions(permissionMap(managedJobs.resolve ?? "", 4), {
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    }) ||
    !samePermissions(permissionMap(managedJobs.execute ?? "", 4), {})
  )
    errors.push("managed executor: resolver or executor permissions changed");
  if (
    /\$\{\{\s*inputs\.prNumber\s*\}\}/.test(
      (managedJobs.resolve ?? "").replace(/^\s*PR_NUMBER:.*$/gm, ""),
    )
  )
    errors.push(
      "managed executor: prNumber must enter trusted code through env only",
    );
  for (const artifact of [
    "swamp-managed-request",
    "swamp-managed-attestation",
    "swamp-managed-diagnostics",
  ]) {
    if (!managed.includes(`name: ${artifact}`))
      errors.push(`managed executor: ${artifact} is missing`);
  }
  if ((managed.match(/^          overwrite: false$/gm) ?? []).length !== 3)
    errors.push("managed executor: artifacts must disable overwrite");
  if (
    !managed.includes("runs-on: ubuntu-24.04") ||
    !/^    timeout-minutes: 60$/m.test(managedJobs.execute ?? "") ||
    managed.includes("persist-credentials: true") ||
    /^    environment:/m.test(managedJobs.execute ?? "") ||
    /secrets\./.test(managedJobs.execute ?? "")
  )
    errors.push(
      "managed executor: hosted credential-free execution contract changed",
    );
  if (
    !managed.includes("swamp workflow run verification") ||
    /\b(?:npm (?:ci|run)|cargo (?:build|check|test|fmt))\b/.test(
      managedJobs.execute ?? "",
    )
  )
    errors.push("managed executor: verification commands must remain in Swamp");

  const gate = candidateWorkflows["swamp-managed-gate.yml"] ?? "";
  if (
    !/^  workflow_run:$/m.test(gate) ||
    !/workflows: \[Swamp managed verification\]/.test(gate) ||
    /^  (?:push|pull_request|pull_request_target|workflow_dispatch):/m.test(
      gate,
    )
  )
    errors.push("managed gate: exact workflow_run trigger is missing");
  if (
    (gate.match(/run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/g) ?? [])
      .length !== 2
  )
    errors.push("managed gate: artifacts must come from the triggering run");
  if (
    !gate.includes("context: 'Swamp managed verification'") ||
    !gate.includes("workflow.path !== expectedPath") ||
    !gate.includes(
      'node "$RUNNER_TEMP/control/scripts/managed-verification-evidence.mjs"',
    ) ||
    /node "\$RUNNER_TEMP\/subject\//.test(gate)
  )
    errors.push(
      "managed gate: trusted identity, validator, or status contract changed",
    );

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

test("shared verification is subject-bounded and never publishes evidence", () => {
  assert.match(managedVerification, /name: subject-preflight/);
  assert.match(managedVerification, /methodName: ci_subject/);
  assert.match(managedVerification, /methodName: run_subject/);
  assert.match(managedVerification, /methodName: collectManaged/);
  assert.match(managedEvidenceCollector, /env: \{ NO_COLOR: "1" \}/);
  assert.doesNotMatch(
    managedVerification,
    /methodName: (?:push|commit|remote_ref)/,
  );
  assert.deepEqual(
    managedPolicy.steps.map((step) => step.name),
    [
      "subject-preflight",
      "dependencies-root",
      "dependencies-client",
      "browser-install",
      "fallback-assets-tests",
      "format",
      "build",
      "rust-verification",
      "typecheck",
      "lint",
      "unit-tests",
      "compatibility",
      "browser-tests",
      "token-audit",
      "accessibility-audit",
      "bundle-budget",
      "bundle",
      "release-validation",
    ],
  );
  assert.deepEqual(managedPolicy.trustBoundaryPaths, [
    ".github/CODEOWNERS",
    ".github/workflows/**",
    ".gitignore",
    ".oxfmtrc.json",
    ".swamp.yaml",
    "AGENTS.md",
    "extensions/models/**",
    "extensions/tests/**",
    "models/**",
    "scripts/managed-verification-evidence.test.mjs",
    "scripts/install-swamp-managed.sh",
    "scripts/managed-verification-evidence.mjs",
    "scripts/workflow-contract.test.mjs",
    "verification/**",
    "workflows/**",
  ]);
  assert.match(
    workflows["swamp-managed-verification.yml"],
    /path: 'verification\/managed-policy\.json'/,
  );
  assert.match(
    workflows["swamp-managed-verification.yml"],
    /previous_filename \? \[filename, previous_filename\]/,
  );
});

test("contract rejects managed executor privilege and gate artifact drift", () => {
  const privileged = mutateWorkflow(
    "swamp-managed-verification.yml",
    (source) =>
      source.replace(
        "    permissions: {}",
        "    permissions:\n      contents: write",
      ),
  );
  const wrongRun = mutateWorkflow("swamp-managed-gate.yml", (source) =>
    source.replaceAll(
      "run-id: ${{ github.event.workflow_run.id }}",
      "run-id: ${{ github.run_id }}",
    ),
  );
  assert.ok(
    auditWorkflowContract(privileged, dependabot, gitleaks).some((error) =>
      error.includes("executor permissions"),
    ),
  );
  assert.ok(
    auditWorkflowContract(wrongRun, dependabot, gitleaks).some((error) =>
      error.includes("triggering run"),
    ),
  );
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
  const retiredJobs = ["evidence", "verify-shadow"].map((job) =>
    mutateWorkflow("ci.yml", (source) =>
      source.replace("jobs:\n", `jobs:\n  ${job}:\n    timeout-minutes: 1\n`),
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
  for (const candidate of retiredJobs) {
    assert.ok(
      auditWorkflowContract(candidate, dependabot, gitleaks).some((error) =>
        error.includes("retired evidence or shadow"),
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

test("contract rejects advisory, CodeQL, and dependency-policy weakening", () => {
  const audit = mutateWorkflow("ci.yml", (source) =>
    source.replace("--version 0.22.2 --locked", "--version 0.22.3"),
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
