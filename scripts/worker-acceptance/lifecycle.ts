import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

const control = await Deno.realPath(Deno.args[0]);
const executorPath = `${control}/.swamp/pulled-extensions/@funsaized/cli-agent/models/cli_agent.ts`;
const { runCli, CLI_AGENT_VERSION } = await import(
  pathToFileURL(executorPath).href
);
const hash = async (path: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await Deno.readFile(path)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
const pins = JSON.parse(
  await Deno.readTextFile(
    `${control}/extensions/models/upstream_extensions.json`,
  ),
);
// Evidence must name the executor bytes actually exercised, not just the
// declared pin: refuse to run if the imported source reports another release.
const declaredExecutor = pins["@funsaized/cli-agent"];
if (CLI_AGENT_VERSION !== declaredExecutor?.version)
  throw new Error(
    `imported executor ${CLI_AGENT_VERSION} does not match pinned ${declaredExecutor?.version}`,
  );
const loadedExecutor = {
  path: ".swamp/pulled-extensions/@funsaized/cli-agent/models/cli_agent.ts",
  version: CLI_AGENT_VERSION,
  sha256: await hash(executorPath),
};
type Entry = { pid: number; startId: string; port?: number };
type Ready = { provider: Entry; listeners: Entry[]; ready: boolean };
type Result = {
  stdout: string;
  stderr: string;
  code: number;
  success: boolean;
  timedOut: boolean;
  timeoutReason?: string;
};
const root = await Deno.realPath(
  await Deno.makeTempDir({ prefix: "ns-lifecycle-" }),
);
const subject = `${root}/subject`;
const bin = `${root}/bin`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await Deno.mkdir(subject);
await Deno.mkdir(bin);
await Deno.writeTextFile(
  `${bin}/opencode`,
  `#!/bin/sh\nexec /usr/bin/python3 ${shellQuote(`${control}/scripts/worker-acceptance/fixtures/detached-listener.py`)} "$@"\n`,
);
await Deno.chmod(`${bin}/opencode`, 0o755);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("executor settlement deadline exceeded")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
function identity(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000,
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
function reaped(entry: Entry): boolean {
  if (!alive(entry.pid)) return true;
  const observed = identity(entry.pid);
  assert.ok(
    observed && entry.startId,
    "live process identity inspection unavailable",
  );
  return observed !== entry.startId;
}
async function readReady(path: string): Promise<Ready | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound || error instanceof SyntaxError)
      return null;
    throw error;
  }
}
async function bind(port = 0): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
const results: object[] = [];
let cleanupEstablished = true;
try {
  assert.equal(
    Deno.build.os,
    "darwin",
    "native Seatbelt acceptance requires macOS",
  );
  const port = await bind();
  for (const role of ["readonly", "actor"]) {
    for (const scenario of ["normal", "wall-timeout", "caller-cancellation"]) {
      const directory = `${root}/${role}-${scenario}`;
      await Deno.mkdir(directory);
      const readyPath = `${directory}/readiness.json`;
      const controller = new AbortController();
      const reason = new Error("owned lifecycle fixture cancellation");
      let readiness: Ready | null = null;
      let settled = false;
      const started = performance.now();
      const execution: Promise<{ result: Result | null; error: unknown }> =
        runCli([`${control}/scripts/nightshift-opencode.py`], {
          cwd: subject,
          env: {
            PATH: `${bin}:${Deno.env.get("PATH")}`,
            NS_FIXTURE_MODE: scenario === "normal" ? "success" : "resistant",
            NS_FIXTURE_READY: readyPath,
            NS_FIXTURE_PORT: String(port),
            NS_FIXTURE_SIGNALS: `${directory}/signals.log`,
          },
          wallTimeoutMs: scenario === "wall-timeout" ? 5000 : 20000,
          idleTimeoutMs: 0,
          signal: controller.signal,
          sandbox: {
            mode: "seatbelt",
            required: true,
            provider: "opencode",
            credentialAccess: "isolated",
            profilePath: `${control}/agent-constraints/nightshift-${role}.sb`,
          },
        }).then(
          (result: Result) => {
            settled = true;
            return { result, error: null };
          },
          (error: unknown) => {
            settled = true;
            return { result: null, error };
          },
        );
      try {
        const deadline = performance.now() + 15000;
        while (!(readiness = await readReady(readyPath))?.ready) {
          if (settled)
            throw new Error(
              `executor settled before fixture readiness: ${JSON.stringify(await execution)}`,
            );
          assert.ok(
            performance.now() < deadline,
            "fixture readiness deadline exceeded",
          );
          await delay(20);
        }
        if (scenario === "caller-cancellation") controller.abort(reason);
        const outcome = await bounded(execution, 30000);
        // No grace-period wait or emergency cleanup before these assertions.
        assert.ok(
          [readiness.provider, ...readiness.listeners].every(reaped),
          "owned process survived executor settlement",
        );
        for (const listener of readiness.listeners) await bind(listener.port);
        await bind(port);
        if (scenario === "caller-cancellation")
          assert.equal(outcome.error, reason);
        else {
          assert.equal(outcome.error, null);
          assert.ok(outcome.result);
          assert.equal(outcome.result.success, scenario === "normal");
          if (scenario === "wall-timeout")
            assert.equal(outcome.result.timedOut, true);
          if (scenario === "wall-timeout")
            assert.equal(outcome.result.timeoutReason, "wall_time_exceeded");
        }
        results.push({
          role,
          scenario,
          passed: true,
          samePortRebound: true,
          elapsedMs: Math.round(performance.now() - started),
        });
      } finally {
        cleanupEstablished = false;
        if (!settled) controller.abort(reason);
        try {
          await bounded(execution, 7000);
        } finally {
          // Recover partial readiness too, but never signal an unverifiable PID.
          const entries = readiness
            ? [readiness.provider, ...readiness.listeners]
            : [];
          for await (const file of Deno.readDir(directory)) {
            if (file.name.startsWith("ready-") && file.name.endsWith(".json")) {
              const entry = JSON.parse(
                await Deno.readTextFile(`${directory}/${file.name}`),
              );
              entries.push(entry);
              if (entry.grandchild) entries.push(entry.grandchild);
            }
          }
          for (const entry of entries) {
            if (
              alive(entry.pid) &&
              entry.startId &&
              identity(entry.pid) === entry.startId
            ) {
              try {
                process.kill(entry.pid, "SIGKILL");
              } catch (error) {
                assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
              }
            }
          }
          const deadline = performance.now() + 5000;
          while (!entries.every(reaped)) {
            assert.ok(
              performance.now() < deadline,
              "fixture emergency cleanup deadline exceeded",
            );
            await delay(25);
          }
          cleanupEstablished = settled;
        }
      }
    }
  }
} finally {
  if (cleanupEstablished) await Deno.remove(root, { recursive: true });
  else
    console.error(
      `cleanup not established; owned readiness retained at ${root}`,
    );
}
console.log(
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      runtime: Deno.version,
      executor: { declared: declaredExecutor, loaded: loadedExecutor },
      hashes: {
        launcher: await hash(`${control}/scripts/nightshift-opencode.py`),
        readonly: await hash(
          `${control}/agent-constraints/nightshift-readonly.sb`,
        ),
        actor: await hash(`${control}/agent-constraints/nightshift-actor.sb`),
      },
      results,
    },
    null,
    2,
  ),
);
