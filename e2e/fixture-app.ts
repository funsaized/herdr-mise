import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("failed to reserve a browser fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export type FixtureApp = {
  appUrl: string;
  pid: number;
  setSnapshot(snapshot: unknown): void;
  startSource(): Promise<void>;
  stopSource(): Promise<void>;
  close(): Promise<void>;
};

export async function startFixtureApp({
  prefix,
  snapshot: initialSnapshot,
  binary = "target/debug/herdr-mise",
}: {
  prefix: string;
  snapshot: unknown;
  binary?: string;
}): Promise<FixtureApp> {
  const directory = await mkdtemp(join(tmpdir(), prefix)),
    socketPath = join(directory, "herdr.sock"),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    sockets = new Set<Socket>();
  let snapshot = initialSnapshot,
    fixtureServer: Server | undefined,
    app: ChildProcess | undefined,
    diagnostics = "";

  const captureDiagnostics = (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-16_384);
  };

  const stopApp = async () => {
      if (!app || app.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => app!.once("exit", resolve));
      app.kill("SIGTERM");
      await Promise.race([exited, delay(2_000)]);
      if (app.exitCode === null) {
        app.kill("SIGKILL");
        await exited;
      }
    },
    stopSource = async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!fixtureServer) return;
      const server = fixtureServer;
      fixtureServer = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    startSource = async () => {
      if (fixtureServer) return;
      fixtureServer = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        let request = "";
        socket.on("data", (chunk) => {
          request += chunk;
          const newline = request.indexOf("\n");
          if (newline < 0) return;
          const method = JSON.parse(request.slice(0, newline)).method;
          if (method === "session.snapshot")
            socket.end(`${JSON.stringify({ result: { snapshot } })}\n`);
          else socket.write('{"result":{"type":"subscription_started"}}\n');
        });
      });
      await new Promise<void>((resolve, reject) => {
        fixtureServer!.once("error", reject);
        fixtureServer!.listen(socketPath, resolve);
      });
    };

  try {
    await startSource();
    app = spawn(binary, [], {
      env: {
        ...process.env,
        HERDR_MISE_PORT: String(port),
        HERDR_SOCKET_PATH: socketPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    app.stdout?.on("data", captureDiagnostics);
    app.stderr?.on("data", captureDiagnostics);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 30_000;
      app!.once("error", reject);
      const poll = async () => {
        if (app?.exitCode !== null)
          return reject(
            new Error(
              `fixture application exited during startup${diagnostics.trim() ? `:\n${diagnostics.trim()}` : ""}`,
            ),
          );
        try {
          if ((await fetch(appUrl)).status === 200) return resolve();
        } catch {
          // Startup races the first loopback request.
        }
        if (Date.now() >= deadline)
          return reject(new Error("fixture application did not become ready"));
        setTimeout(poll, 100);
      };
      void poll();
    });
  } catch (error) {
    await stopApp();
    await stopSource();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    appUrl,
    pid: app.pid!,
    setSnapshot(value) {
      snapshot = value;
      for (const socket of sockets)
        if (socket.writable)
          socket.write('{"event":"snapshot_changed","data":{}}\n');
    },
    startSource,
    stopSource,
    async close() {
      await stopApp();
      await stopSource();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
