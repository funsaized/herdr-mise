#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const REQUIRED_GATES = Object.freeze({
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
  keyboard: "manual",
  "voiceover-speech-focus": "manual",
  "runtime-reduced-motion": "manual",
  "blocked-recognition-two-meters": "manual",
  upgrade: "manual",
  uninstall: "manual",
  "multi-day-soak": "soak",
});

const rcFields = ["tag", "version", "commit", "artifacts"];
const promotionFields = ["tag", "version", "commit"];
const publicArtifactFields = [
  "target",
  "archive",
  "sha256",
  "archive_url",
  "checksum_url",
];
const artifactReferenceFields = ["target", "archive", "sha256"];
const acceptedRcCommit = "d17c3b754eab230c9dd3933cbb614c1cd75dec97";
const supportedArtifacts = new Map([
  [
    "aarch64-apple-darwin",
    "260e9a2d851969e31e07559a3ea05123192b9f1415c4ef60f7e5d7133d083e5f",
  ],
  [
    "x86_64-apple-darwin",
    "885cccad2335b3d44d3139a9a99d8fbb1944a6045fbf1fc4e05feeefc6fa6347",
  ],
  [
    "x86_64-unknown-linux-gnu",
    "c264cb1df9602cf582b1d87c40b6ceb86870240483ed8f66ff22d21675ec6b20",
  ],
]);
const rowFields = [
  "gate_id",
  "category",
  "scope",
  "tester",
  "platform",
  "executed_against",
  "command_or_action",
  "result",
  "timestamp",
  "evidence_ref",
];
const exactKeys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
const nonempty = (value) =>
  typeof value === "string" && value.trim() === value && value.length > 0;
const exactObject = (left, right, fields) =>
  fields.every((field) => left?.[field] === right?.[field]);
const artifactKey = (artifact) =>
  artifactReferenceFields.map((field) => artifact?.[field]).join("\0");
const sha256 = (value) => /^[0-9a-f]{64}$/.test(value ?? "");
const commit = (value) => /^[0-9a-f]{40}$/.test(value ?? "");
const stableTag = (value) =>
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value ?? "");
const rcTag = (value) =>
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(
    value ?? "",
  );
const timestamp = (value) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    value ?? "",
  ) && !Number.isNaN(Date.parse(value));
const placeholder = (value) =>
  /REPLACE_WITH_|HTTPS_(?:ARCHIVE|CHECKSUM)_URL|external:\/\/NOT_RUN/.test(
    value ?? "",
  );
const privateData = (value) =>
  /(?:\/Users\/|\/home\/)|(?:authorization|token|password|secret)=/i.test(
    value ?? "",
  );

export const isMainModule = (argvPath, moduleUrl) =>
  Boolean(argvPath) && resolve(argvPath) === resolve(fileURLToPath(moduleUrl));

function validateAcceptedRc(rc, errors) {
  if (!exactKeys(rc, rcFields)) {
    errors.push("accepted_rc has missing or unknown field(s)");
    return new Set();
  }
  if (rc.tag !== "v0.1.0-rc.1" || !rcTag(rc.tag))
    errors.push("accepted_rc tag must be public v0.1.0-rc.1");
  if (rc.version !== rc.tag?.slice(1))
    errors.push("accepted_rc version must match tag");
  if (!commit(rc.commit))
    errors.push(
      "accepted_rc commit must be 40 lowercase hexadecimal characters",
    );
  else if (rc.commit !== acceptedRcCommit)
    errors.push("accepted_rc commit does not match public v0.1.0-rc.1");
  if (!Array.isArray(rc.artifacts) || rc.artifacts.length !== 3) {
    errors.push("accepted_rc must contain exactly the three supported targets");
    return new Set();
  }
  const references = new Set();
  const targets = new Set();
  const archives = new Set();
  for (const [index, artifact] of rc.artifacts.entries()) {
    const label = `accepted_rc.artifacts[${index}]`;
    if (!exactKeys(artifact, publicArtifactFields)) {
      errors.push(`${label} has missing or unknown field(s)`);
      continue;
    }
    if (!nonempty(artifact.target) || !/^[a-z0-9_-]+$/.test(artifact.target))
      errors.push(`${label} target is invalid`);
    const expectedArchive = `herdr-mise-${rc.tag}-${artifact.target}.tar.gz`;
    if (artifact.archive !== expectedArchive)
      errors.push(`${label} archive does not match RC tag and target`);
    if (!sha256(artifact.sha256)) errors.push(`${label} sha256 is invalid`);
    if (supportedArtifacts.get(artifact.target) !== artifact.sha256)
      errors.push(`${label} sha256 does not match published RC sidecar`);
    const base = `https://github.com/funsaized/herdr-mise/releases/download/${rc.tag}/${artifact.archive}`;
    if (artifact.archive_url !== base)
      errors.push(`${label} archive_url is not the exact public RC URL`);
    if (artifact.checksum_url !== `${base}.sha256`)
      errors.push(`${label} checksum_url is not the exact public RC URL`);
    const key = artifactKey(artifact);
    if (
      references.has(key) ||
      targets.has(artifact.target) ||
      archives.has(artifact.archive)
    )
      errors.push(`${label} duplicate accepted_rc artifact`);
    references.add(key);
    targets.add(artifact.target);
    archives.add(artifact.archive);
  }
  if (
    targets.size !== supportedArtifacts.size ||
    [...supportedArtifacts.keys()].some((target) => !targets.has(target))
  )
    errors.push("accepted_rc must contain exactly the three supported targets");
  return references;
}

export function validateEvidence(document, expectedPromotion) {
  const errors = [];
  if (
    !exactKeys(document, [
      "schema_version",
      "accepted_rc",
      "promotion",
      "gates",
    ])
  )
    return ["document has missing or unknown field(s)"];
  if (document.schema_version !== 2) errors.push("schema_version must equal 2");
  const acceptedArtifacts = validateAcceptedRc(document.accepted_rc, errors);
  if (!exactKeys(document.promotion, promotionFields))
    errors.push("promotion has missing or unknown field(s)");
  else {
    if (!stableTag(document.promotion.tag))
      errors.push("promotion tag must be canonical stable SemVer");
    if (document.promotion.version !== document.promotion.tag.slice(1))
      errors.push("promotion version must match tag");
    if (!commit(document.promotion.commit))
      errors.push(
        "promotion commit must be 40 lowercase hexadecimal characters",
      );
    if (!exactObject(document.promotion, expectedPromotion, promotionFields))
      errors.push("promotion context mismatch");
  }
  if (!Array.isArray(document.gates))
    return [...errors, "gates must be an array"];

  const fullProductCounts = new Map();
  for (const [index, row] of document.gates.entries()) {
    const label = `gates[${index}]`;
    if (!exactKeys(row, rowFields)) {
      errors.push(`${label} has missing or unknown field(s)`);
      continue;
    }
    if (!(row.gate_id in REQUIRED_GATES))
      errors.push(`${label} has unknown gate_id`);
    if (!["automated", "manual", "soak"].includes(row.category))
      errors.push(`${label} has invalid category`);
    if (!["full-product", "scoped-subsystem"].includes(row.scope))
      errors.push(`${label} has invalid scope`);
    for (const field of [
      "tester",
      "platform",
      "command_or_action",
      "evidence_ref",
    ])
      if (!nonempty(row[field]))
        errors.push(`${label} ${field} must be non-empty`);
    if (!["PASS", "FAIL", "NOT_RUN"].includes(row.result))
      errors.push(`${label} has invalid result`);
    if (!timestamp(row.timestamp))
      errors.push(`${label} timestamp must be RFC 3339 with an offset`);
    if (
      /[\r\n\0<>]|\$\(|`|&&|\|\||[;|]|\{\{[^}]+\}\}/.test(row.command_or_action)
    )
      errors.push(`${label} malformed command_or_action`);
    if (
      [row.tester, row.platform, row.command_or_action, row.evidence_ref].some(
        privateData,
      )
    )
      errors.push(`${label} contains private data`);
    if (row.result === "PASS") {
      if (
        [
          row.tester,
          row.platform,
          row.command_or_action,
          row.evidence_ref,
        ].some(placeholder) ||
        row.timestamp === "1970-01-01T00:00:00Z"
      )
        errors.push(`${label} PASS row contains placeholder evidence`);
    }
    const executed = row.executed_against;
    if (!exactKeys(executed, rcFields))
      errors.push(`${label} executed_against has missing or unknown field(s)`);
    else {
      if (
        !exactObject(executed, document.accepted_rc, [
          "tag",
          "version",
          "commit",
        ])
      )
        errors.push(`${label} executed_against RC mismatch`);
      if (!Array.isArray(executed.artifacts) || executed.artifacts.length === 0)
        errors.push(`${label} executed_against artifacts must be non-empty`);
      else {
        const seen = new Set();
        for (const reference of executed.artifacts) {
          if (!exactKeys(reference, artifactReferenceFields)) {
            errors.push(
              `${label} artifact reference has missing or unknown field(s)`,
            );
            continue;
          }
          const key = artifactKey(reference);
          if (!acceptedArtifacts.has(key))
            errors.push(`${label} artifact is not in accepted_rc`);
          if (seen.has(key))
            errors.push(`${label} duplicate artifact reference`);
          seen.add(key);
        }
      }
    }
    if (row.scope === "full-product" && row.gate_id in REQUIRED_GATES) {
      fullProductCounts.set(
        row.gate_id,
        (fullProductCounts.get(row.gate_id) ?? 0) + 1,
      );
      if (row.category !== REQUIRED_GATES[row.gate_id])
        errors.push(`${label} category mismatch`);
      if (row.result !== "PASS") errors.push(`${label} must be PASS`);
    }
  }
  for (const gate of Object.keys(REQUIRED_GATES)) {
    const count = fullProductCounts.get(gate) ?? 0;
    if (count === 0) errors.push(`missing required gate: ${gate}`);
    if (count > 1) errors.push(`duplicate required gate: ${gate}`);
  }
  return errors;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error("arguments must be --name value pairs");
    if (key.slice(2) in result) throw new Error(`duplicate ${key}`);
    result[key.slice(2)] = value;
  }
  for (const name of [
    "evidence",
    "promotion-tag",
    "promotion-version",
    "promotion-commit",
  ])
    if (!result[name]) throw new Error(`missing --${name}`);
  return result;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const document = JSON.parse(readFileSync(args.evidence, "utf8"));
    const errors = validateEvidence(document, {
      tag: args["promotion-tag"],
      version: args["promotion-version"],
      commit: args["promotion-commit"],
    });
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("acceptance_evidence=PASS");
  } catch (error) {
    console.error(`acceptance_evidence=FAIL\n${error.message}`);
    process.exitCode = 1;
  }
}
