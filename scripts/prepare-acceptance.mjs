import { readFileSync } from "node:fs";
import { isMainModule } from "./validate-acceptance-evidence.mjs";

// Emits a candidate for review; never publishes, edits version files, or certifies gates.
export function prepareAcceptance(promotionTag, rc) {
  if (
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(promotionTag) ||
    !rc ||
    !new RegExp(`^${promotionTag.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`).test(
      rc.tag,
    ) ||
    rc.version !== rc.tag.slice(1) ||
    !/^[0-9a-f]{40}$/.test(rc.commit)
  )
    throw new Error("Expected a stable promotion and its exact RC identity");
  const targets = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
  ];
  if (
    !Array.isArray(rc.artifacts) ||
    rc.artifacts.length !== targets.length ||
    new Set(rc.artifacts.map((a) => a.target)).size !== targets.length
  )
    throw new Error("Expected all three distinct RC artifacts");
  const artifacts = {};
  for (const artifact of rc.artifacts) {
    if (
      !targets.includes(artifact.target) ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      artifact.archive !== `herdr-mise-${rc.tag}-${artifact.target}.tar.gz`
    )
      throw new Error("Invalid RC artifact identity");
    artifacts[artifact.target] = artifact.sha256;
  }
  return {
    schemaVersion: 1,
    promotionTag,
    acceptedRcTag: rc.tag,
    acceptedRcCommit: rc.commit,
    artifacts,
  };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    const [, , promotionTag, evidencePath] = process.argv;
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    console.log(
      JSON.stringify(
        prepareAcceptance(promotionTag, evidence.accepted_rc),
        null,
        2,
      ),
    );
    console.error(
      `Review acceptance/releases/${promotionTag}.json; intentionally update server/Cargo.toml, Cargo.lock, herdr-plugin.toml, installer default, and release notes. Collect new evidence against the accepted RC; no gate has been marked PASS.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
