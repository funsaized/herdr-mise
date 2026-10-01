// Import-safe shared capture helpers for the browser media captures.
//
// This module performs no work at import time: no git guard, no directory
// creation, no child processes, and no static Playwright import. Callers run
// `verifyCommittedSource` themselves and dynamically import Playwright only
// after the guard has passed, so temp-repo tests can supply stub dependencies.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";

const delay = (ms) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export function createCaptureTools(root) {
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
    if (result.error)
      throw new Error(`${command} could not start: ${result.error.message}`);
    if (result.status !== 0)
      throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  }

  function encode(args) {
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  }

  function probe(path) {
    return JSON.parse(
      run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height:format=duration",
        "-of",
        "json",
        path,
      ]),
    );
  }

  async function digest(path) {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }

  return { run, encode, probe, digest };
}

/**
 * Require a clean, committed source tree and return the source commit.
 * Must run before any capture directory, dynamic capture module, or process.
 */
export function verifyCommittedSource(root) {
  const { run } = createCaptureTools(root);
  const sourceCommit = run("git", ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit))
    throw new Error(`invalid source commit: ${sourceCommit}`);
  if (run("git", ["status", "--porcelain"]))
    throw new Error("media capture requires a clean committed source tree");
  return sourceCommit;
}

/**
 * Spawn the client visual dev server and wait until it answers `baseUrl`.
 * Returns `{ stop, log }`: `stop()` terminates the process group, `log()`
 * returns the accumulated server output.
 */
async function answers(baseUrl) {
  try {
    return (await fetch(baseUrl)).ok;
  } catch {
    return false;
  }
}

export async function startVisualServer(root, baseUrl) {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  // Capture must record this checkout. If something already answers at the
  // URL (for example another checkout's visual server), --strictPort would
  // reject ours and readiness would silently succeed against the other one.
  if (await answers(baseUrl))
    throw new Error(
      `${baseUrl} is already serving; stop it before capturing this checkout`,
    );
  const server = spawn(
    "npm",
    [
      "--prefix",
      "client",
      "run",
      "dev:visual",
      "--",
      "--host",
      url.hostname,
      "--port",
      port,
      "--strictPort",
    ],
    { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );

  let log = "";
  server.stdout.on("data", (chunk) => (log += chunk));
  server.stderr.on("data", (chunk) => (log += chunk));
  server.on("exit", (code) => {
    if (code) console.error(log.trim());
  });

  async function stop() {
    if (server.exitCode !== null) return;
    const exited = new Promise((resolveExit) =>
      server.once("exit", resolveExit),
    );
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
    await Promise.race([exited, delay(3_000)]);
    if (server.exitCode === null && server.signalCode === null) {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        server.kill("SIGKILL");
      }
      await exited;
    }
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    // Only our own live server can satisfy readiness.
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error(
        `visual server exited before becoming ready at ${baseUrl}:\n${log.trim()}`,
      );
    if (await answers(baseUrl)) return { stop, log: () => log };
    await delay(100);
  }
  await stop();
  throw new Error(`visual server did not become ready at ${baseUrl}`);
}

export async function openVisual(page, baseUrl, query) {
  await page.goto(`${baseUrl}/?${query}`, { waitUntil: "networkidle" });
  await page.locator("canvas").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  const dismiss = page.getByRole("button", { name: "Got it" });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.waitForTimeout(450);
}

/**
 * Create a staging directory under `docs/assets` for one capture profile,
 * e.g. `.capture-web-XXXXXX` or `.capture-product-XXXXXX`.
 */
export async function createStaging(root, profile) {
  const output = join(root, "docs", "assets");
  await mkdir(output, { recursive: true });
  return mkdtemp(join(output, `.capture-${profile}-`));
}

export function remainingFrameDelay(
  startedAt,
  completedFrames,
  now,
  frameRate = 20,
) {
  return Math.max(0, startedAt + completedFrames * (1_000 / frameRate) - now);
}
