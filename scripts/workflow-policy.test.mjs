import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

// Generic supply-chain and least-privilege policy for GitHub workflows.
// Syntax, expressions, and embedded shell are delegated to actionlint.

const directory = ".github/workflows";
const workflows = Object.fromEntries(
  readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => [name, readFileSync(`${directory}/${name}`, "utf8")]),
);

const readOnly = { contents: "read" };
// Top-level permissions per workflow; anything unlisted must be contents: read.
const topPermissions = {
  "swamp-managed-verification.yml": {},
  "swamp-managed-gate.yml": {
    actions: "read",
    contents: "read",
    "pull-requests": "read",
    statuses: "write",
  },
};
// Job-level permission blocks are exceptions and must match exactly.
const jobPermissions = {
  "release.yml/publish": { contents: "write" },
  "codeql.yml/analyze": {
    actions: "read",
    contents: "read",
    "security-events": "write",
  },
  "gitleaks.yml/scan": { contents: "read", "pull-requests": "read" },
  "swamp-managed-verification.yml/execute": {},
};
const required = [
  "ci.yml",
  "codeql.yml",
  "dependency-review.yml",
  "gitleaks.yml",
  "release.yml",
  "swamp-managed-gate.yml",
  "swamp-managed-verification.yml",
];

function permissionMap(block, indent) {
  if (new RegExp(`^ {${indent}}permissions: \\{\\}$`, "m").test(block))
    return {};
  const marker = `${" ".repeat(indent)}permissions:\n`;
  const start = block.indexOf(marker);
  if (start < 0) return null;
  const entries = {};
  for (const line of block.slice(start + marker.length).split("\n")) {
    const match = line.match(
      new RegExp(`^ {${indent + 2}}([a-z-]+): (read|write|none)$`),
    );
    if (!match) break;
    entries[match[1]] = match[2];
  }
  return entries;
}

function jobBlocks(source) {
  const start = source.indexOf("\njobs:\n");
  if (start < 0) return {};
  const tail = source.slice(start + 7);
  const matches = [...tail.matchAll(/^  ([a-zA-Z0-9_-]+):\n/gm)];
  return Object.fromEntries(
    matches.map((match, index) => [
      match[1],
      tail.slice(match.index, matches[index + 1]?.index ?? tail.length),
    ]),
  );
}

const same = (actual, expected) =>
  actual !== null && JSON.stringify(actual) === JSON.stringify(expected);

export function auditWorkflows(candidates) {
  const errors = [];
  for (const name of required)
    if (!(name in candidates))
      errors.push(`${name}: required workflow missing`);

  for (const [name, source] of Object.entries(candidates)) {
    for (const [index, line] of source.split("\n").entries()) {
      const uses = line.match(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+(#.*))?$/);
      if (!uses || uses[1].startsWith("./")) continue;
      if (!/@[0-9a-f]{40}$/.test(uses[1]))
        errors.push(`${name}:${index + 1}: action not pinned to a full SHA`);
      if (!uses[2] || !/^#\s*\S+/.test(uses[2]))
        errors.push(
          `${name}:${index + 1}: pinned action lacks a version comment`,
        );
    }
    if (/^\s*pull_request_target:/m.test(source))
      errors.push(`${name}: pull_request_target is forbidden`);
    if (!same(permissionMap(source, 0), topPermissions[name] ?? readOnly))
      errors.push(`${name}: top-level permissions exceed policy`);
    if (
      name !== "release.yml" &&
      !/^concurrency:\n  group: .+\n  cancel-in-progress: true$/m.test(source)
    )
      errors.push(`${name}: cancellable concurrency is required`);

    for (const [job, block] of Object.entries(jobBlocks(source))) {
      if (!/^    timeout-minutes: [1-9][0-9]*$/m.test(block))
        errors.push(`${name}/${job}: timeout-minutes is required`);
      const permissions = permissionMap(block, 4);
      if (
        permissions !== null &&
        !same(permissions, jobPermissions[`${name}/${job}`])
      )
        errors.push(`${name}/${job}: job permissions exceed policy`);
    }
  }
  return errors;
}

test("repository workflows satisfy the supply-chain and permission policy", () => {
  assert.deepEqual(auditWorkflows(workflows), []);
});

test("policy rejects unpinned actions, privileged triggers, and broadened permissions", () => {
  const ci = workflows["ci.yml"];
  const mutate = (source) => auditWorkflows({ ...workflows, "ci.yml": source });
  assert.match(
    mutate(
      ci.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v7"),
    ).join("\n"),
    /not pinned/,
  );
  assert.match(
    mutate(ci.replace("on:\n", "on:\n  pull_request_target:\n")).join("\n"),
    /pull_request_target/,
  );
  assert.match(
    mutate(ci.replace("contents: read", "contents: write")).join("\n"),
    /top-level permissions/,
  );
  assert.match(
    mutate(ci.replace(/^    timeout-minutes: \d+\n/m, "")).join("\n"),
    /timeout-minutes/,
  );
});

test("actionlint accepts every workflow", { skip: !hasActionlint() }, () => {
  const result = spawnSync("actionlint", ["-no-color"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

function hasActionlint() {
  return spawnSync("actionlint", ["-version"]).status === 0;
}
