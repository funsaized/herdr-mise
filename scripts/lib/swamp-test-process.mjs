import { spawn } from "node:child_process";

export function parseLastJson(text) {
  for (
    let index = text.lastIndexOf("{");
    index >= 0;
    index = text.lastIndexOf("{", index - 1)
  ) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      /* progress precedes result */
    }
  }
  throw new Error(`No JSON result in:\n${text}`);
}

export function runJson(executable, args, options = {}, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error;
    child.on("error", (cause) => {
      error = cause;
    });
    child.stdin.on("error", (cause) => {
      error ??= cause;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      try {
        if (error) throw error;
        const json = parseLastJson(stdout || stderr);
        resolve({ status, stdout, stderr, json });
      } catch (cause) {
        reject(
          new Error(
            `${executable} failed: ${cause.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            { cause },
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    child.kill("SIGTERM");
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

export async function startServe(repo) {
  const child = spawn(
    "swamp",
    [
      "serve",
      "--repo-dir",
      repo,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--auth-mode",
      "none",
      "--no-schedule",
    ],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  try {
    const server = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => done(new Error("startup readiness deadline exceeded")),
        8000,
      );
      const onError = (error) => done(error);
      const onClose = () => done(new Error("server exited before readiness"));
      function done(error, url) {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("close", onClose);
        if (error) reject(error);
        else resolve(url);
      }
      const onData = (chunk) => {
        logs += chunk;
        const url = logs.match(
          /WebSocket API server listening on "(ws:\/\/127\.0\.0\.1:\d+)"/,
        )?.[1];
        if (url && logs.includes("Startup complete")) done(null, url);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", onError);
      child.once("close", onClose);
    });
    return { child, server, logs: () => logs };
  } catch (cause) {
    await stopChild(child);
    throw new Error(`swamp serve failed to start: ${cause.message}\n${logs}`, {
      cause,
    });
  }
}
