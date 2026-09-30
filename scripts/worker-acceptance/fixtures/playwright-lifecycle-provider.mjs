// Stand-in `opencode` provider resolved from PATH by the production launcher
// scripts/nightshift-opencode.py. It launches the workspace's real
// @playwright/test CLI so acceptance exercises Playwright's webServer
// lifecycle inside the supervised invocation.
import { execFileSync, spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.env.NS_PW_REPO_ROOT;
const config = process.env.NS_PW_CONFIG;
const readyPath = process.env.NS_PW_PROVIDER_READY;
if (!repoRoot || !config) {
  throw new Error("NS_PW_REPO_ROOT and NS_PW_CONFIG are required");
}

function startId(pid) {
  try {
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

if (readyPath) {
  const temporary = `${readyPath}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({
      ready: true,
      pid: process.pid,
      startId: startId(process.pid),
    }),
  );
  renameSync(temporary, readyPath);
}

const cli = join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const runner = spawn(process.execPath, [cli, "test", "--config", config], {
  stdio: "inherit",
});
runner.on("error", (error) => {
  console.error(`playwright-lifecycle provider: ${error.message}`);
  process.exit(1);
});
runner.on("exit", (code) => process.exit(code ?? 1));
