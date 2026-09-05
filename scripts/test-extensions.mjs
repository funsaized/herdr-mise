import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Swamp installs the matching Deno runtime. Managed execution supplies its
// absolute path because npm subjects deliberately have an isolated HOME.
const deno =
  process.env.DENO_EXEC_PATH ?? join(homedir(), ".swamp", "deno", "deno");
if (!existsSync(deno))
  throw new Error(
    "Deno runtime missing: run swamp doctor extensions, then set DENO_EXEC_PATH to its denoPath.",
  );
const result = spawnSync(
  deno,
  [
    "test",
    "--node-modules-dir=none",
    "--no-lock",
    "--no-prompt",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run=git",
    "extensions/tests",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
