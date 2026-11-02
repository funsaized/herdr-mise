import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function releaseSummary(releases, supported) {
  if (!Array.isArray(releases))
    throw new Error("Expected an upstream release list");
  const known = new Set(supported.map(({ release }) => `v${release}`));
  // Upstream text is untrusted; emit only validated tag names and fixed-origin links.
  const tags = releases
    .filter(
      (release) =>
        !release.draft &&
        /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.tag_name),
    )
    .map(({ tag_name }) => tag_name);
  return [
    "### Herdr release discovery",
    "",
    ...tags.map(
      (tag) =>
        `- [${tag}](https://github.com/herdrdev/herdr/releases/tag/${tag}): ${known.has(tag.startsWith("v") ? tag : `v${tag}`) ? "supported release" : "candidate; compatibility review required"}`,
    ),
    "",
    "Discovery is advisory. Only compatibility/herdr.json defines supported protocols.",
    "",
  ].join("\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const response = await fetch(
    "https://api.github.com/repos/herdrdev/herdr/releases?per_page=20",
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`Upstream discovery failed: HTTP ${response.status}`);
  const manifest = JSON.parse(
    await readFile(
      new URL("../compatibility/herdr.json", import.meta.url),
      "utf8",
    ),
  );
  console.log(releaseSummary(await response.json(), manifest.supported));
}
