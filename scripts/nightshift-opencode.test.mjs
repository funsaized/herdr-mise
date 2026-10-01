import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Exercises the real scripts/nightshift-opencode.py launcher with a fake
// `opencode` on PATH (scripts/worker-acceptance/fixtures/detached-listener.py).
// The launcher must leave no descendant of the provider alive after the
// provider exits or the launcher is terminated. The fixture records real
// listening sockets, pids and kernel start identities for safe cleanup.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher =
  process.env.NS_LAUNCHER ?? join(root, "scripts/nightshift-opencode.py");
const fixture = join(
  root,
  "scripts/worker-acceptance/fixtures/detached-listener.py",
);
const python =
  process.env.NS_FIXTURE_PYTHON ??
  (existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3");

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
 * A descendant is reaped only on confirmed disappearance or a successfully
 * inspected, same-source identity showing pid reuse. While the pid is alive,
 * an unavailable or incomparable identity fails closed (not reaped).
 */
function reaped(entry, inspect = currentIdentity) {
  if (!entry || !Number.isInteger(entry.pid)) return false;
  if (!isAlive(entry.pid)) return true;
  if (!entry.startId) return false;
  const current = inspect(entry.pid);
  if (!current || current.source !== "ps") return false;
  return current.value !== entry.startId;
}

function fixtureEntries(readiness) {
  if (!readiness) return [];
  return [readiness.provider, ...(readiness.listeners ?? [])].filter(Boolean);
}

function emergencyKillEntries(entries) {
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

function emergencyKill(readiness) {
  emergencyKillEntries(fixtureEntries(readiness));
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

async function readReadiness(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function awaitReadiness(path, run, timeout = 25_000) {
  let readiness;
  await waitFor(
    async () => {
      readiness = await readReadiness(path);
      if (!readiness?.ready && run.child.exitCode !== null) {
        throw new Error(
          `provider exited before readiness\n${formatOutput(run.output)}`,
        );
      }
      return Boolean(readiness?.ready);
    },
    { timeout, label: `readiness file ${path}` },
  );
  return readiness;
}

async function assertEntriesReaped(entries, timeout = 15_000) {
  await waitFor(() => entries.every((entry) => reaped(entry)), {
    timeout,
    label: `all fixture descendants reaped: ${entries
      .map((entry) => `${entry.role ?? "provider"}:${entry.pid}`)
      .join(", ")}`,
  });
}

async function assertReaped(readiness, timeout = 15_000) {
  return assertEntriesReaped(fixtureEntries(readiness), timeout);
}

/**
 * Readiness identities available from a harness directory. The aggregate file
 * is written last, so a failed readiness handshake leaves only per-child
 * `ready-*.json` identities; retaining them keeps failure cleanup exact.
 */
async function partialEntries(harness) {
  const entries = [];
  for (const name of await readdir(harness.directory)) {
    if (!name.startsWith("ready-") || !name.endsWith(".json")) continue;
    const entry = await readReadiness(join(harness.directory, name));
    if (entry && Number.isInteger(entry.pid)) entries.push(entry);
  }
  return entries;
}

/**
 * Bounded teardown of supervised launchers: SIGTERM first so the launcher can
 * reap its own descendants, a fixed grace, then SIGKILL escalation.
 */
async function terminateLaunchers(runs, grace = 8_000) {
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
      await delay(25);
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

/** Best-effort reap wait, then exact-identity emergency kill of leftovers. */
async function emergencyReap(entries, timeout = 5_000) {
  try {
    await assertEntriesReaped(entries, timeout);
  } catch {
    // Escalate below instead of masking the reaping failure.
  }
  emergencyKillEntries(entries);
  await assertEntriesReaped(entries, timeout);
}

async function cleanupHarness(harness, launched, readiness) {
  await terminateLaunchers(launched);
  const entries = [
    ...fixtureEntries(readiness),
    ...(await partialEntries(harness)),
    ...fixtureEntries(await readReadiness(harness.readyPath)),
  ];
  await emergencyReap(entries);
  await rm(harness.directory, { recursive: true, force: true });
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
  // The owning process was already confirmed dead; allow a bounded retry for
  // lingering TIME_WAIT before declaring the socket still bound.
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

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "ns-detached-"));
  const binDir = join(directory, "bin");
  await mkdir(binDir, { recursive: true });
  const shim = join(binDir, "opencode");
  await writeFile(shim, `#!/bin/sh\nexec "${python}" "${fixture}" "$@"\n`);
  await chmod(shim, 0o755);
  return {
    directory,
    binDir,
    readyPath: join(directory, "readiness.json"),
    signalsPath: join(directory, "signals.log"),
  };
}

async function reset(harness) {
  await rm(harness.readyPath, { force: true });
  await rm(harness.signalsPath, { force: true });
}

function launch(harness, { mode, port, echoStdin = false }) {
  const child = spawn(python, [launcher, "--fixture", mode], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
      NS_FIXTURE_MODE: mode,
      NS_FIXTURE_READY: harness.readyPath,
      NS_FIXTURE_SIGNALS: harness.signalsPath,
      ...(port ? { NS_FIXTURE_PORT: String(port) } : {}),
      ...(echoStdin ? { NS_FIXTURE_ECHO_STDIN: "1" } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
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
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  exit.catch(() => {});
  return { child, exit, output };
}

async function awaitExit(run, timeout = 20_000) {
  let timer;
  try {
    return await Promise.race([
      run.exit,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `launcher did not exit within ${timeout}ms\n${formatOutput(
                run.output,
              )}`,
            ),
          );
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    run.child.stdout?.destroy();
    run.child.stderr?.destroy();
    run.child.stdin?.destroy();
  }
}

test(
  "nightshift launcher reaps detached listeners after provider exit",
  { timeout: 120_000 },
  async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX process-group and socket semantics are required");
      return;
    }
    const harness = await createHarness();
    const launched = [];
    let readiness;
    try {
      const port = await reservePort();
      for (const scenario of [
        { mode: "ordinary", code: 0 },
        { mode: "success", code: 0 },
        { mode: "failure", code: 7 },
        { mode: "immediate", code: 0 },
      ]) {
        const { mode, code: expectedCode } = scenario;
        await reset(harness);
        const run = launch(harness, { mode, port, echoStdin: true });
        launched.push(run);
        run.child.stdin.end("stdin-probe\n");
        readiness = await awaitReadiness(harness.readyPath, run);
        assert.equal(readiness.mode, mode);
        assert.ok(
          readiness.listeners.length >= 2,
          `${mode}: expected listener records`,
        );
        const { code } = await awaitExit(run);
        assert.equal(
          code,
          expectedCode,
          `${mode} exit code\n${formatOutput(run.output)}`,
        );
        await assertReaped(readiness);
        for (const listener of readiness.listeners) {
          await assertPortFree(listener.port, `${mode}/${listener.role}`);
        }
        await assertPortFree(port, `${mode}/primary`);
        // fd 0/1/2 pass through the launcher unchanged.
        assert.match(
          run.output.stdout,
          new RegExp(`NS_FIXTURE_STDOUT ${mode}`),
        );
        assert.match(
          run.output.stderr,
          new RegExp(`NS_FIXTURE_STDERR ${mode}`),
        );
        assert.match(run.output.stdout, /NS_FIXTURE_STDIN stdin-probe/);
        emergencyKill(readiness);
        readiness = undefined;
      }

      // Fail-closed identity regression: unavailable or incomparable
      // inspection must never be accepted as proof that a live process was
      // reaped, while confirmed disappearance and same-source reuse still are.
      await t.test("live identity inspection fails closed", async () => {
        const probe = spawn(python, ["-c", "import time; time.sleep(60)"], {
          stdio: "ignore",
        });
        try {
          await waitFor(() => isAlive(probe.pid), {
            timeout: 10_000,
            label: "identity probe process",
          });
          const real = currentIdentity(probe.pid);
          assert.ok(
            real && real.source === "ps",
            "probe identity must be readable",
          );
          const recorded = { pid: probe.pid, startId: real.value };
          assert.equal(
            reaped(recorded),
            false,
            "live same-identity pid is not reaped",
          );
          assert.equal(
            reaped(recorded, () => null),
            false,
            "unavailable inspection must not count as reaped",
          );
          assert.equal(
            reaped(recorded, () => ({ source: "proc", value: "0" })),
            false,
            "ps timestamp must not be compared to proc ticks",
          );
          assert.equal(
            identityMatches(recorded.pid, recorded.startId, () => null),
            false,
          );
          assert.equal(
            reaped(recorded, () => ({ source: "ps", value: "reused" })),
            true,
            "same-source identity mismatch proves pid reuse",
          );
          probe.kill("SIGKILL");
          await waitFor(() => !isAlive(probe.pid), {
            timeout: 10_000,
            label: "identity probe disappearance",
          });
          assert.equal(
            reaped(recorded),
            true,
            "confirmed disappearance counts as reaped",
          );
        } finally {
          try {
            probe.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }
      });
    } finally {
      await cleanupHarness(harness, launched, readiness);
    }
  },
);

test(
  "nightshift launcher reaps detached listeners on termination",
  { timeout: 120_000 },
  async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX process-group and socket semantics are required");
      return;
    }
    const harness = await createHarness();
    const launched = [];
    let readiness;
    try {
      const port = await reservePort();

      await reset(harness);
      let run = launch(harness, { mode: "hold", port });
      launched.push(run);
      run.child.stdin.end();
      readiness = await awaitReadiness(harness.readyPath, run);
      assert.equal(readiness.mode, "hold");
      for (const listener of readiness.listeners) {
        assert.ok(
          isAlive(listener.pid),
          `hold/${listener.role} should be alive before termination`,
        );
        await assertConnectable(listener.port, `hold/${listener.role}`);
      }
      run.child.kill("SIGTERM");
      await awaitExit(run);
      await assertReaped(readiness);
      for (const listener of readiness.listeners) {
        await assertPortFree(listener.port, `hold/${listener.role}`);
      }
      await assertPortFree(port, "hold/primary");
      emergencyKill(readiness);
      readiness = undefined;

      await reset(harness);
      run = launch(harness, { mode: "resistant", port });
      launched.push(run);
      run.child.stdin.end();
      readiness = await awaitReadiness(harness.readyPath, run);
      assert.equal(readiness.mode, "resistant");
      for (const listener of readiness.listeners) {
        assert.ok(
          isAlive(listener.pid),
          `resistant/${listener.role} should be alive before termination`,
        );
      }
      run.child.kill("SIGTERM");
      await awaitExit(run);
      await assertReaped(readiness);
      for (const listener of readiness.listeners) {
        await assertPortFree(listener.port, `resistant/${listener.role}`);
      }
      await assertPortFree(port, "resistant/primary");
      const signals = await readFile(harness.signalsPath, "utf8");
      assert.match(
        signals,
        /^detached SIGTERM$/m,
        "resistant listener must get SIGTERM before the SIGKILL escalation",
      );
      emergencyKill(readiness);
      readiness = undefined;

      // Failure-path regression: a listener binds and records its identity, but
      // aggregate readiness never arrives. The harness must fail, then still
      // reap every recorded process and release the bound port.
      await t.test("withheld aggregate readiness is cleaned up", async () => {
        const failureHarness = await createHarness();
        const failureRun = launch(failureHarness, {
          mode: "incomplete",
          port: await reservePort(),
        });
        failureRun.child.stdin.end();
        let partial = [];
        try {
          await waitFor(
            async () => {
              partial = await partialEntries(failureHarness);
              return partial.some((entry) => entry.socketBound === true);
            },
            { timeout: 20_000, label: "partial listener readiness" },
          );
          assert.equal(
            await readReadiness(failureHarness.readyPath),
            null,
            "aggregate readiness must stay withheld",
          );
          await assert.rejects(
            awaitReadiness(failureHarness.readyPath, failureRun, 2_000),
            /readiness/,
          );
        } finally {
          await terminateLaunchers([failureRun]);
          partial = await partialEntries(failureHarness);
          await emergencyReap(partial);
          await rm(failureHarness.directory, { recursive: true, force: true });
        }
        await assertEntriesReaped(partial);
        for (const listener of partial) {
          if (!listener.port) continue;
          await assertPortFree(
            listener.port,
            `incomplete/${listener.role ?? "listener"}`,
          );
        }
      });
    } finally {
      await cleanupHarness(harness, launched, readiness);
    }
  },
);

test(
  "nightshift launcher preserves unrelated listeners across invocations",
  { timeout: 120_000 },
  async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX process-group and socket semantics are required");
      return;
    }
    const unrelated = createServer();
    await new Promise((resolve, reject) => {
      unrelated.once("error", reject);
      unrelated.listen(0, "127.0.0.1", resolve);
    });
    const address = unrelated.address();
    const unrelatedPort =
      typeof address === "object" && address ? address.port : 0;
    const harness = await createHarness();
    const launched = [];
    const invocationIds = [];
    let readiness;
    try {
      for (const mode of ["success", "failure"]) {
        await reset(harness);
        const run = launch(harness, { mode, port: await reservePort() });
        launched.push(run);
        run.child.stdin.end();
        readiness = await awaitReadiness(harness.readyPath, run);
        if (
          typeof readiness.invocationId === "string" &&
          readiness.invocationId.length > 0
        ) {
          invocationIds.push(readiness.invocationId);
        }
        const { code } = await awaitExit(run);
        assert.equal(
          code,
          mode === "failure" ? 7 : 0,
          `${mode} exit code\n${formatOutput(run.output)}`,
        );
        await assertReaped(readiness);
        assert.equal(
          unrelated.listening,
          true,
          `${mode}: unrelated listener must stay bound`,
        );
        await assertConnectable(unrelatedPort, "unrelated listener");
        emergencyKill(readiness);
        readiness = undefined;
      }
      if (invocationIds.length >= 2) {
        assert.notEqual(
          invocationIds[0],
          invocationIds[1],
          "NIGHTSHIFT_INVOCATION_ID must be fresh per invocation",
        );
      } else {
        t.diagnostic(
          "launcher did not export NIGHTSHIFT_INVOCATION_ID; freshness check skipped",
        );
      }
    } finally {
      try {
        await cleanupHarness(harness, launched, readiness);
      } finally {
        if (unrelated.listening) {
          await new Promise((resolve) => unrelated.close(resolve));
        }
      }
    }
  },
);
