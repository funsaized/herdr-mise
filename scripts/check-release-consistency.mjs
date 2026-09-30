import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCargoVersion, validateReleaseTag } from "./release-policy.mjs";

const targets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
];
const releaseUrl = "https://github.com/funsaized/herdr-mise/releases";

function requireCondition(condition, source, message) {
  if (!condition) throw new Error(`${source}: ${message}`);
}

function section(text, heading, source) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(heading);
  requireCondition(start !== -1, source, `missing ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  let inFence = false;
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    if (/^```/.test(line)) inFence = !inFence;
    return !inFence && new RegExp(`^#{1,${level}} `).test(line);
  });
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function publishedGuidance(text, source) {
  const prose = text.replace(/\s+/g, " ");
  requireCondition(
    !/unavailable until|once the stable release is published|no stable archive or checksum is claimed before publication/i.test(
      prose,
    ),
    source,
    "contains unpublished-release wording",
  );
}

function currentExamples(text, tag, source) {
  publishedGuidance(text, source);
  // Archive targets are filename suffixes, not SemVer prerelease identifiers.
  for (const target of [...targets, "<target>"]) {
    text = text.replaceAll(`-${target}.tar.gz`, " ");
  }
  for (const match of text.matchAll(/\bv\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g)) {
    requireCondition(
      match[0] === tag,
      source,
      `current-release example ${match[0]} must be ${tag}`,
    );
  }
}

function platformGuidance(text, source) {
  for (const token of [
    ...targets,
    "Ubuntu 24.04",
    "glibc 2.39",
    "older glibc",
    "musl",
    "Windows",
    "Linux ARM",
    "not claimed supported",
  ]) {
    requireCondition(
      text.toLowerCase().includes(token.toLowerCase()),
      source,
      `missing platform/baseline statement: ${token}`,
    );
  }
}

function normalized(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
}

// This is a post-publication check, not a prerequisite for preparing the next version.
export function checkReleaseConsistency({ root = ".", release, latest }) {
  const read = (file) => readFileSync(resolve(root, file), "utf8");
  const version = readCargoVersion(resolve(root, "server/Cargo.toml"));
  const { tag, isPrerelease } = validateReleaseTag(release.tag_name, version);
  requireCondition(!isPrerelease, "release.tag_name", "expected a stable tag");
  const expectedAssets = targets
    .flatMap((target) => {
      const archive = `herdr-mise-${tag}-${target}.tar.gz`;
      return [archive, `${archive}.sha256`];
    })
    .sort();
  for (const [source, metadata] of [
    ["release", release],
    ["latest", latest],
  ]) {
    requireCondition(
      metadata.tag_name === tag,
      `${source}.tag_name`,
      `must match ${tag}`,
    );
    requireCondition(
      metadata.draft === false,
      `${source}.draft`,
      "must be false",
    );
    requireCondition(
      metadata.prerelease === false,
      `${source}.prerelease`,
      "must be false",
    );
    requireCondition(
      typeof metadata.published_at === "string" &&
        Number.isFinite(Date.parse(metadata.published_at)),
      `${source}.published_at`,
      "must be a publication timestamp",
    );
    requireCondition(
      Array.isArray(metadata.assets) &&
        metadata.assets.every((asset) => typeof asset?.name === "string"),
      `${source}.assets`,
      "must be an array of named assets",
    );
    const names = metadata.assets.map((asset) => asset.name).sort();
    requireCondition(
      JSON.stringify(names) === JSON.stringify(expectedAssets),
      `${source}.assets`,
      `expected exactly three archive/sidecar pairs: ${expectedAssets.join(", ")}`,
    );
  }
  requireCondition(
    read("herdr-plugin.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1] ===
      version,
    "herdr-plugin.toml",
    `version must be ${version}`,
  );
  requireCondition(
    read("install.sh").match(/^HERDR_MISE_VERSION=(\S+)$/m)?.[1] === version,
    "install.sh",
    `HERDR_MISE_VERSION must be ${version}`,
  );

  const readme = read("README.md");
  const quickStart = section(readme, "## Quick start", "README.md");
  currentExamples(quickStart, tag, "README.md Quick start");
  requireCondition(
    quickStart.includes(`${releaseUrl}/tag/${tag}`),
    "README.md Quick start",
    `missing current release link ${tag}`,
  );
  platformGuidance(
    section(readme, "## Security and limitations", "README.md"),
    "README.md Security and limitations",
  );

  const operations = read("docs/operations.md");
  publishedGuidance(
    section(operations, "## Installation", "docs/operations.md"),
    "docs/operations.md Installation",
  );
  const archive = section(
    operations,
    "### Run the release archive",
    "docs/operations.md",
  );
  currentExamples(archive, tag, "docs/operations.md Run the release archive");
  requireCondition(
    archive.includes(`TAG=${tag}`) &&
      archive.includes(`${releaseUrl}/tag/${tag}`),
    "docs/operations.md Run the release archive",
    `missing current TAG or release link ${tag}`,
  );
  platformGuidance(archive, "docs/operations.md Run the release archive");
  const tableTargets = [...archive.matchAll(/^\|[^|\n]+\|\s*`([^`]+)`\s*\|$/gm)]
    .map((match) => match[1])
    .filter((name) => name !== "TARGET")
    .sort();
  requireCondition(
    JSON.stringify(tableTargets) === JSON.stringify([...targets].sort()),
    "docs/operations.md platform table",
    "must contain exactly the three supported targets",
  );
  const verification = section(
    operations,
    "### Verifying an archive",
    "docs/operations.md",
  );
  currentExamples(verification, tag, "docs/operations.md Verifying an archive");
  for (const target of [targets[0], targets[2]]) {
    requireCondition(
      verification.includes(`herdr-mise-${tag}-${target}.tar.gz.sha256`),
      "docs/operations.md Verifying an archive",
      `missing checksum example for ${target}`,
    );
  }

  const support = section(
    read("SECURITY.md"),
    "## Supported versions",
    "SECURITY.md",
  );
  requireCondition(
    support.includes("Only the newest stable release") &&
      support.includes(`${releaseUrl}/latest`) &&
      !/\bv\d+\.\d+\.\d+/.test(support),
    "SECURITY.md Supported versions",
    "must identify newest stable via GitHub Latest without a duplicated version",
  );

  const notesFile = `docs/releases/${tag}.md`;
  const notes = read(notesFile);
  const install = section(notes, "## Install", notesFile);
  currentExamples(install, tag, `${notesFile} Install`);
  requireCondition(
    install.includes(`${releaseUrl}/tag/${tag}`),
    notesFile,
    `missing release link ${tag}`,
  );
  platformGuidance(
    section(notes, "## Limitations", notesFile),
    `${notesFile} Limitations`,
  );
  for (const [source, metadata] of [
    ["release", release],
    ["latest", latest],
  ]) {
    requireCondition(
      typeof metadata.body === "string",
      `${source}.body`,
      "missing release prose",
    );
    publishedGuidance(metadata.body, `${source}.body`);
    const prose = metadata.body
      .replace(/\r\n/g, "\n")
      .split(/^## Checksums\s*$/m);
    requireCondition(
      prose.length === 2,
      `${source}.body`,
      "expected one generated Checksums section",
    );
    requireCondition(
      normalized(prose[0]) === normalized(notes),
      `${source}.body`,
      `published prose differs from ${notesFile}`,
    );
  }
  return tag;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2)
      throw new Error(
        "Usage: node scripts/check-release-consistency.mjs <release.json> <latest.json>",
      );
    const [release, latest] = args.map((file) =>
      JSON.parse(readFileSync(file, "utf8")),
    );
    process.stdout.write(
      `${checkReleaseConsistency({ release, latest })}: release guidance is consistent\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
