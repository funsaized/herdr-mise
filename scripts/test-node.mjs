import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [tier, ...args] = process.argv.slice(2);
if (!["unit", "factory"].includes(tier))
  throw new Error("Expected unit or factory test tier");
const files = readdirSync(new URL(".", import.meta.url))
  .filter(
    (name) =>
      name.endsWith(".test.mjs") &&
      name.endsWith(".integration.test.mjs") === (tier === "factory"),
  )
  .sort()
  .map((name) => `scripts/${name}`);
if (!files.length) throw new Error(`No tests found for ${tier}`);
const result = spawnSync(process.execPath, ["--test", ...args, ...files], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
