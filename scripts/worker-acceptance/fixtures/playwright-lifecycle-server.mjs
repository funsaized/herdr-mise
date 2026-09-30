// Owned dummy HTTP origin behind Playwright's fixture webServer (#304).
// It records its pid and kernel start identity so the acceptance harness can
// emergency-kill only this process, never a pid that has since been reused.
import { execFileSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.NS_PW_PORT);
const readyPath = process.env.NS_PW_SERVER_READY;
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("NS_PW_PORT must name a valid TCP port");
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

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok\n");
});

server.listen(port, "127.0.0.1", () => {
  if (!readyPath) return;
  const temporary = `${readyPath}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({
      ready: true,
      pid: process.pid,
      startId: startId(process.pid),
      port: server.address().port,
    }),
  );
  renameSync(temporary, readyPath);
});
