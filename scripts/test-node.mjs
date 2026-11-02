import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [tier, ...args] = process.argv.slice(2);
if (!["unit", "release", "media"].includes(tier))
  throw new Error("Expected unit, release or media test tier");
const directory = tier === "media" ? "scripts/media" : "scripts";
const files = readdirSync(
  new URL(tier === "media" ? "./media/" : ".", import.meta.url),
)
  .filter(
    (name) =>
      name.endsWith(".test.mjs") &&
      (tier === "media" ||
        name.endsWith(".release.test.mjs") === (tier === "release")),
  )
  .sort()
  .map((name) => `${directory}/${name}`);
if (!files.length) throw new Error(`No tests found for ${tier}`);
const result = spawnSync(process.execPath, ["--test", ...args, ...files], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
