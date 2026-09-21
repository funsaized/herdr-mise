import { toFileUrl } from "jsr:@std/path@1.1.2";
const control = await Deno.realPath(Deno.args[0]);
const { runCli } = await import(
  toFileUrl(
    `${control}/.swamp/pulled-extensions/@funsaized/cli-agent/models/cli_agent.ts`,
  ).href
);
const root = await Deno.realPath(
  await Deno.makeTempDir({ prefix: "ns-sock-" }),
);
const subject = `${root}/subject`;
await Deno.mkdir(subject);
const results = [];
const bin = `${root}/bin`;
await Deno.mkdir(bin);
await Deno.writeTextFile(
  `${bin}/opencode`,
  `#!/usr/bin/python3
import errno, os
assert all(name not in os.environ for name in ("SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO"))
try:
 os.write(123,b'dummy-socket-write');print('inherited-usable')
except OSError as error:
 print('closed' if error.errno == errno.EBADF else 'denied')
`,
);
await Deno.chmod(`${bin}/opencode`, 0o755);
try {
  for (const role of ["readonly", "actor"]) {
    const result = await runCli(
      [`${control}/scripts/nightshift-opencode.py`, "--version"],
      {
        cwd: subject,
        env: {
          PATH: `${bin}:${Deno.env.get("PATH")}`,
          SSH_AUTH_SOCK: "/dummy-only",
          SSH_AGENT_PID: "123",
          GPG_AGENT_INFO: "/dummy-only",
        },
        wallTimeoutMs: 15000,
        idleTimeoutMs: 0,
        sandbox: {
          mode: "seatbelt",
          required: true,
          provider: "opencode",
          credentialAccess: "isolated",
          profilePath: `${control}/agent-constraints/nightshift-${role}.sb`,
        },
      },
    );
    results.push({
      role,
      check: "extra-inherited-socket",
      code: result.code,
      observed: result.stdout.trim(),
      passed: result.success && result.stdout.trim() === "closed",
    });
  }
} finally {
  await Deno.remove(root, { recursive: true });
}
console.log(
  JSON.stringify({ observedAt: new Date().toISOString(), results }, null, 2),
);

if (results.some((row) => !row.passed)) Deno.exitCode = 1;
