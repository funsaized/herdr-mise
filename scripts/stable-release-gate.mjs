import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCargoVersion, validateReleaseTag } from "./release-policy.mjs";

export function evaluateStableReleaseGate({
  tag,
  cargoVersion,
  commit,
  evidencePath,
  validatorPath = "scripts/validate-acceptance-evidence.mjs",
}) {
  const classification = validateReleaseTag(tag, cargoVersion);
  if (classification.isPrerelease) {
    return { required: false, releaseClass: "prerelease" };
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
    throw new Error(
      "Stable candidate commit must be exactly 40 lowercase hex characters",
    );
  }
  if (!evidencePath) {
    throw new Error("Stable acceptance evidence path is required");
  }
  if (!existsSync(evidencePath) || statSync(evidencePath).size === 0) {
    throw new Error("Stable acceptance evidence is missing or empty");
  }
  const result = spawnSync(
    process.execPath,
    [
      validatorPath,
      "--evidence",
      evidencePath,
      "--promotion-tag",
      classification.tag,
      "--promotion-version",
      classification.version,
      "--promotion-commit",
      commit,
    ],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    const diagnostic = (result.stderr || result.error?.message || "").trim();
    throw new Error(
      `Stable acceptance evidence validation failed${diagnostic ? `: ${diagnostic}` : ""}`,
    );
  }
  if (!result.stdout.split(/\r?\n/).includes("acceptance_evidence=PASS")) {
    throw new Error(
      "Stable acceptance validator did not emit the required PASS marker",
    );
  }
  return {
    required: true,
    releaseClass: "stable",
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) return undefined;
  return args[index + 1];
}

function main(args) {
  const tag = option(args, "--promotion-tag");
  const commit = option(args, "--promotion-commit");
  const evidencePath = option(args, "--evidence");
  if (!tag || !commit) {
    throw new Error(
      "Usage: node scripts/stable-release-gate.mjs --promotion-tag <tag> --promotion-commit <sha> [--evidence <file>]",
    );
  }
  const decision = evaluateStableReleaseGate({
    tag,
    cargoVersion: readCargoVersion(),
    commit,
    evidencePath,
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
