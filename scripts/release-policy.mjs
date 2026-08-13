import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const identifier = "(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const releaseTagPattern = new RegExp(
  `^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?$`,
);

export function classifyReleaseTag(tag) {
  const match = releaseTagPattern.exec(tag);
  if (!match) {
    throw new Error(
      `Invalid release tag ${JSON.stringify(tag)}: expected canonical SemVer with a v prefix and no build metadata`,
    );
  }

  const version = tag.slice(1);
  const isPrerelease = match[4] !== undefined;
  return {
    tag,
    version,
    releaseClass: isPrerelease ? "prerelease" : "stable",
    isPrerelease,
  };
}

export function validateReleaseTag(tag, authoritativeVersion) {
  const classification = classifyReleaseTag(tag);
  if (classification.version !== authoritativeVersion) {
    throw new Error(
      `Release tag ${tag} does not match authoritative Cargo version ${authoritativeVersion}`,
    );
  }
  return classification;
}

export function readCargoVersion(path = "server/Cargo.toml") {
  const cargo = readFileSync(path, "utf8");
  let inPackage = false;
  let version;
  for (const line of cargo.split("\n")) {
    const table = line.match(/^\[([^\]]+)\]\s*$/)?.[1];
    if (table) {
      if (inPackage) break;
      inPackage = table === "package";
      continue;
    }
    if (inPackage) {
      version ??= line.match(/^version\s*=\s*"([^"]+)"\s*$/)?.[1];
    }
  }
  if (!version) {
    throw new Error(`Could not read package version from ${path}`);
  }
  return version;
}

function writeGitHubOutput(classification) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `tag=${classification.tag}`,
      `version=${classification.version}`,
      `release_class=${classification.releaseClass}`,
      `is_prerelease=${classification.isPrerelease}`,
      "",
    ].join("\n"),
  );
}

function main(args) {
  if (args.length !== 2 || args[0] !== "classify-tag") {
    throw new Error(
      "Usage: node scripts/release-policy.mjs classify-tag <tag>",
    );
  }
  const classification = validateReleaseTag(args[1], readCargoVersion());
  writeGitHubOutput(classification);
  process.stdout.write(`${JSON.stringify(classification)}\n`);
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
