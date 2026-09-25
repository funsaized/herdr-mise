// Rewrite the funsaized/homebrew-tap formula for a published release using the
// release's own .sha256 sidecars (never local rebuilds). Opening the tap pull
// request stays a maintainer action; see docs/releasing.md.
//
//   node scripts/homebrew-formula.mjs v0.3.0 < herdr-mise.rb > herdr-mise.rb.new
import { pathToFileURL } from "node:url";
import { classifyReleaseTag } from "./release-policy.mjs";

export const TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
];
const REPOSITORY = "funsaized/herdr-mise";

export function assetUrl(tag, target) {
  return `https://github.com/${REPOSITORY}/releases/download/${tag}/herdr-mise-${tag}-${target}.tar.gz`;
}

/** Replace each target's url/sha256 pair; every target must appear exactly once. */
export function updateFormula(formula, tag, checksums) {
  const { releaseClass } = classifyReleaseTag(tag);
  if (releaseClass !== "stable")
    throw new Error(`Homebrew only ships stable releases, not ${tag}`);
  let updated = formula;
  for (const target of TARGETS) {
    const sha = checksums[target];
    if (!/^[0-9a-f]{64}$/.test(sha ?? ""))
      throw new Error(`missing or malformed sha256 for ${target}`);
    const pattern = new RegExp(
      `url "https://github\\.com/${REPOSITORY}/releases/download/[^/"]+/herdr-mise-[^"]+-${target}\\.tar\\.gz"\\n(\\s+)sha256 "[0-9a-f]{64}"`,
      "g",
    );
    const matches = [...updated.matchAll(pattern)];
    if (matches.length !== 1)
      throw new Error(
        `expected one url/sha256 pair for ${target}, found ${matches.length}`,
      );
    updated = updated.replace(
      pattern,
      (_match, indent) =>
        `url "${assetUrl(tag, target)}"\n${indent}sha256 "${sha}"`,
    );
  }
  return updated;
}

/** A sidecar is "<sha256>  <archive name>" for exactly the expected archive. */
export function parseSidecar(text, tag, target) {
  const match = text.trim().match(/^([0-9a-f]{64}) [ *](\S+)$/);
  if (!match || match[2] !== `herdr-mise-${tag}-${target}.tar.gz`)
    throw new Error(`unexpected sidecar for ${target}: ${text.trim()}`);
  return match[1];
}

async function main() {
  const tag = process.argv[2];
  if (!tag)
    throw new Error("usage: homebrew-formula.mjs <stable tag> < formula");
  const checksums = {};
  for (const target of TARGETS) {
    const response = await fetch(`${assetUrl(tag, target)}.sha256`);
    if (!response.ok)
      throw new Error(
        `sidecar download failed for ${target}: ${response.status}`,
      );
    checksums[target] = parseSidecar(await response.text(), tag, target);
  }
  let formula = "";
  for await (const chunk of process.stdin) formula += chunk;
  process.stdout.write(updateFormula(formula, tag, checksums));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
