import { toFileUrl } from "jsr:@std/path@1.1.2";
const control = await Deno.realPath(Deno.args[0]);
const { runCli } = await import(
  toFileUrl(
    `${control}/.swamp/pulled-extensions/@funsaized/cli-agent/models/cli_agent.ts`,
  ).href
);
const root = await Deno.realPath(
  await Deno.makeTempDir({ prefix: "ns-unix-" }),
);
const home = `${root}/home`;
const subject = `${root}/subject`;
await Deno.mkdir(`${home}/.ssh`, { recursive: true });
await Deno.mkdir(subject);
const results = [];
try {
  for (const role of ["readonly", "actor"]) {
    const socket = `${home}/.ssh/agent.sock`;
    const listener = Deno.listen({ transport: "unix", path: socket });
    const serving = listener
      .accept()
      .then(async (connection) => {
        try {
          await connection.write(
            new TextEncoder().encode("dummy-broker-response"),
          );
        } finally {
          connection.close();
        }
      })
      .catch(() => {});
    try {
      const policy = (
        await Deno.readTextFile(
          `${control}/agent-constraints/nightshift-${role}.sb`,
        )
      ).replace('(define HOME (param "HOME"))', `(define HOME "${home}")`);
      const profile = `${root}/${role}.sb`;
      await Deno.writeTextFile(profile, policy);
      const code = `const net=require('node:net');const s=net.createConnection(process.argv[1]);s.on('data',x=>process.stdout.write(x));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(2),2000).unref();`;
      const r = await runCli(["node", "-e", code, socket], {
        cwd: subject,
        wallTimeoutMs: 5000,
        idleTimeoutMs: 0,
        sandbox: {
          mode: "seatbelt",
          required: true,
          provider: "opencode",
          credentialAccess: "isolated",
          profilePath: profile,
        },
      });
      results.push({
        role,
        check: "unix-credential-broker",
        code: r.code,
        reachable: r.stdout === "dummy-broker-response",
      });
    } finally {
      listener.close();
      await serving;
      try {
        await Deno.remove(socket);
      } catch {}
    }
  }
} finally {
  await Deno.remove(root, { recursive: true });
}
console.log(
  JSON.stringify({ observedAt: new Date().toISOString(), results }, null, 2),
);

if (results.some((row) => row.reachable || row.code !== 1)) Deno.exitCode = 1;
