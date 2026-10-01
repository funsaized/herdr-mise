#!/usr/bin/env node
// Bounded acceptance for #304: the production OpenCode launcher
// (scripts/nightshift-opencode.py) must reap the detached Playwright webServer
// process group when an invocation is interrupted. The harness substitutes a
// fixture `opencode` on PATH that launches the repository's real
// @playwright/test CLI against the browser-free fixture config. A second run on
// the same port with reuseExistingServer:false must then succeed.
//
// This proves the actual Playwright lifecycle through the launcher. It uses an
// OS signal on the launcher, not the cli-agent AbortSignal path, so it does not
// prove AbortSignal propagation.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
// NS_LAUNCHER exists for manual negative controls against a non-supervising
// launcher; the acceptance always runs the production launcher by default.
const launcher =
  process.env.NS_LAUNCHER ?? join(root, "scripts", "nightshift-opencode.py");
const fixtures = join(root, "scripts", "worker-acceptance", "fixtures");
const provider = join(fixtures, "playwright-lifecycle-provider.mjs");
const config = join(fixtures, "playwright-lifecycle.config.mjs");
const playwrightCli = join(
  root,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const python = existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
const OVERALL_MS = 300_000;
const READY_MS = 90_000;
const SETTLE_MS = 60_000;
const SECOND_RUN_MS = 120_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatOutput(output) {
  return `stdout:\n${output.stdout}\nstderr:\n${output.stderr}`;
}

/** True while the pid names a live (or not-yet-reaped) process. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Kernel start identity for a pid, tagged with its source. `ps` covers macOS
 * and Linux; `/proc` is the Linux fallback when process inspection is
 * restricted. Identities from different sources are never comparable.
 */
function currentIdentity(pid) {
  const viaPs = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (viaPs.status === 0) {
    const value = (viaPs.stdout ?? "").trim();
    if (value) return { source: "ps", value };
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const value = after[19] ?? null; // field 22: starttime
      return value === null ? null : { source: "proc", value };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fixtures record `startId` from `ps -o lstart=`, so a recorded identity is
 * always a `ps` timestamp. A successful match requires a live pid and the same
 * source; proc ticks never compare equal to a ps timestamp.
 */
function identityMatches(pid, startId, inspect = currentIdentity) {
  if (!startId || !isAlive(pid)) return false;
  const current = inspect(pid);
  return Boolean(
    current && current.source === "ps" && current.value === startId,
  );
}

/**
 * A recorded descendant is reaped only on confirmed disappearance or a
 * successfully inspected, same-source identity showing pid reuse. While the
 * pid is alive, an unavailable or incomparable identity fails closed.
 */
function reaped(entry, inspect = currentIdentity) {
  if (!entry || !Number.isInteger(entry.pid)) return false;
  if (!isAlive(entry.pid)) return true;
  if (!entry.startId) return false;
  const current = inspect(entry.pid);
  if (!current || current.source !== "ps") return false;
  return current.value !== entry.startId;
}

/** Emergency cleanup: only signal pids whose recorded identity still matches. */
function emergencyKill(entries) {
  for (const entry of entries) {
    if (entry && identityMatches(entry.pid, entry.startId)) {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

/**
 * Readiness identities available from a harness directory. A failed
 * server-ready/provider-ready handshake leaves only the files that were
 * written; retaining them keeps failure cleanup exact.
 */
async function readinessEntries(harness) {
  const entries = [];
  for (const path of [harness.serverReady, harness.providerReady]) {
    const entry = await readJson(path);
    if (entry && Number.isInteger(entry.pid)) entries.push(entry);
  }
  return entries;
}

async function assertEntriesReaped(entries, timeout = 5_000) {
  await waitFor(() => entries.every((entry) => reaped(entry)), {
    timeout,
    label: `recorded fixture identities reaped: ${entries
      .map((entry) => `${entry.pid}`)
      .join(", ")}`,
  });
}

/**
 * Bounded teardown of supervised launchers: SIGTERM first so the launcher can
 * reap its own descendants, a fixed grace, then SIGKILL escalation. Readiness
 * files are read before the harness directory is removed so partial identities
 * recorded by a failed run remain available.
 */
async function terminateLaunchers(runs, grace = 15_000) {
  for (const run of runs) {
    if (run.child.exitCode === null && run.child.signalCode === null) {
      try {
        run.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  const deadline = Date.now() + grace;
  for (const run of runs) {
    while (
      run.child.exitCode === null &&
      run.child.signalCode === null &&
      Date.now() < deadline
    )
      await delay(50);
  }
  for (const run of runs) {
    if (run.child.exitCode === null && run.child.signalCode === null) {
      try {
        run.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await waitFor(
    () =>
      runs.every(
        (run) => run.child.exitCode !== null || run.child.signalCode !== null,
      ),
    {
      timeout: 2000,
      label: "launcher termination after escalation",
    },
  );
}

async function cleanupHarness(harness, launched, recorded) {
  await terminateLaunchers(launched);
  const entries = [...recorded, ...(await readinessEntries(harness))].filter(
    Boolean,
  );
  try {
    await assertEntriesReaped(entries);
  } catch {
    // Fall through to the identity-checked emergency kill.
  }
  emergencyKill(entries);
  await assertEntriesReaped(entries);
  await rm(harness.directory, { recursive: true, force: true });
}

async function waitFor(check, options = {}) {
  const { timeout = 10_000, interval = 50, label = "condition" } = options;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(interval);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function assertPortFree(port, label) {
  // The launcher has already settled; allow a bounded retry for lingering
  // TIME_WAIT before declaring the port still owned.
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    } finally {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  }
  throw new Error(`port ${port} (${label}) still in use: ${lastError.message}`);
}

function assertConnectable(port, label, timeout = 3_000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no connection to ${label} on 127.0.0.1:${port}`));
    }, timeout);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `no connection to ${label} on 127.0.0.1:${port}: ${error.message}`,
        ),
      );
    });
  });
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "ns-playwright-lifecycle-"));
  const binDir = join(directory, "bin");
  await mkdir(binDir, { recursive: true });
  const shim = join(binDir, "opencode");
  await writeFile(
    shim,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(provider)} "$@"\n`,
  );
  await chmod(shim, 0o755);
  return {
    directory,
    binDir,
    serverReady: join(directory, "server-ready.json"),
    providerReady: join(directory, "provider-ready.json"),
    marker: join(directory, "marker.json"),
  };
}

function launch(harness, port, hold, withholdProviderReady = false) {
  const child = spawn(python, [launcher], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
      NS_PW_REPO_ROOT: root,
      NS_PW_CONFIG: config,
      NS_PW_PORT: String(port),
      NS_PW_SERVER_READY: harness.serverReady,
      NS_PW_PROVIDER_READY: harness.providerReady,
      NS_PW_MARKER: harness.marker,
      NS_PW_HOLD: hold ? "1" : "0",
      ...(withholdProviderReady ? { NS_PW_WITHHOLD_PROVIDER_READY: "1" } : {}),
      NS_PW_OUTPUT_DIR: join(harness.directory, "results"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  // Settlement is the launcher process exiting. `close` would additionally
  // wait on stdio pipes that a leaked descendant can hold open, which would
  // mask the missing-port-free signal behind a timeout instead.
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  exit.catch(() => {});
  return { child, exit, output };
}

async function awaitExit(run, timeout, label) {
  let timer;
  try {
    return await Promise.race([
      run.exit,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label} did not exit within ${timeout}ms\n${formatOutput(run.output)}`,
            ),
          );
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    run.child.stdout?.destroy();
    run.child.stderr?.destroy();
  }
}

async function resetHarness(harness) {
  for (const path of [
    harness.serverReady,
    harness.providerReady,
    harness.marker,
  ]) {
    await rm(path, { force: true });
  }
}

async function main() {
  // Deterministic inspection failures against a genuinely live PID; these
  // seams never signal the process or claim an actual observed PID replacement.
  const recorded = { pid: process.pid, startId: "recorded ps timestamp" };
  assert.equal(
    reaped(recorded, () => null),
    false,
  );
  assert.equal(
    reaped(recorded, () => ({ source: "proc", value: "123" })),
    false,
  );
  assert.equal(
    reaped(recorded, () => ({ source: "ps", value: recorded.startId })),
    false,
  );
  assert.equal(
    reaped(recorded, () => ({ source: "ps", value: "different timestamp" })),
    true,
  );
  // A bound server alone must not satisfy aggregate readiness. Cleanup must
  // still retain its identity when the provider handshake never arrives.
  const failureHarness = await createHarness();
  const failurePort = await reservePort();
  const failureRun = launch(failureHarness, failurePort, true, true);
  let partial = [];
  try {
    await waitFor(
      async () => {
        partial = await readinessEntries(failureHarness);
        return partial.some((entry) => entry.port === failurePort);
      },
      { timeout: READY_MS, label: "partial webServer readiness" },
    );
    await assert.rejects(
      waitFor(
        async () => {
          const providerEntry = await readJson(failureHarness.providerReady);
          return providerEntry?.ready === true;
        },
        { timeout: 1000, label: "withheld provider readiness" },
      ),
      /readiness/,
    );
  } finally {
    await cleanupHarness(failureHarness, [failureRun], partial);
  }
  assert.ok(partial.length > 0);
  await assertEntriesReaped(partial);
  await assertPortFree(failurePort, "partial-readiness failure cleanup");
  console.log("server-ready/provider-not-ready failure cleanup passed");
  assert.ok(existsSync(launcher), `production launcher missing: ${launcher}`);
  assert.ok(
    existsSync(playwrightCli),
    `@playwright/test CLI missing at ${playwrightCli}; run npm ci`,
  );

  const port = await reservePort();
  const harness = await createHarness();
  const launched = [];
  let emergency = [];

  try {
    // First invocation: reach Playwright webServer readiness, then interrupt
    // the supervised launcher and assert the port is free the moment it settles.
    await resetHarness(harness);
    const first = launch(harness, port, true);
    launched.push(first);
    let serverEntry;
    let providerEntry;
    await waitFor(
      async () => {
        serverEntry = await readJson(harness.serverReady);
        providerEntry = await readJson(harness.providerReady);
        emergency = [serverEntry, providerEntry].filter(Boolean);
        return serverEntry?.ready === true && providerEntry?.ready === true;
      },
      { timeout: READY_MS, label: "fixture provider and webServer readiness" },
    );
    emergency = [serverEntry, providerEntry];
    await waitFor(
      async () => (await readJson(harness.marker))?.ready === true,
      { timeout: READY_MS, label: "first-run Playwright test readiness" },
    );
    await assertConnectable(serverEntry.port, "first-run fixture webServer");

    first.child.kill("SIGTERM");
    const firstExit = await awaitExit(first, SETTLE_MS, "first launcher run");
    console.log(
      `first run settled (code=${firstExit.code}, signal=${firstExit.signal})`,
    );

    // Strict check: the port must be free immediately at launcher settlement,
    // before any harness-owned emergency teardown runs.
    await assertPortFree(serverEntry.port, "first-run launcher settlement");
    await waitFor(() => reaped(serverEntry) && reaped(providerEntry), {
      timeout: 5_000,
      label: "fixture process identities reaped at settlement",
    });

    // Second invocation: reuseExistingServer:false on the same port must now
    // start cleanly and complete successfully.
    await resetHarness(harness);
    const second = launch(harness, port, false);
    launched.push(second);
    const secondExit = await awaitExit(
      second,
      SECOND_RUN_MS,
      "second launcher run",
    );
    assert.equal(
      secondExit.code,
      0,
      `second same-port run must succeed\n${formatOutput(second.output)}`,
    );
    assert.equal(secondExit.signal, null, "second run must exit normally");
    console.log("second same-port run succeeded");
  } finally {
    await cleanupHarness(harness, launched, emergency);
  }
}

const watchdog = setTimeout(() => {
  console.error(`playwright lifecycle acceptance exceeded ${OVERALL_MS}ms`);
  process.exit(1);
}, OVERALL_MS);
watchdog.unref?.();

main()
  .then(() => clearTimeout(watchdog))
  .catch((error) => {
    clearTimeout(watchdog);
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
