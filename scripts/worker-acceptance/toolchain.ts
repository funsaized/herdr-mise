import { toFileUrl } from "jsr:@std/path@1.1.2";
const control = await Deno.realPath(Deno.args[0]);
const subject = await Deno.realPath(Deno.args[1]);
const { runCli } = await import(
  toFileUrl(
    `${control}/.swamp/pulled-extensions/@funsaized/cli-agent/models/cli_agent.ts`,
  ).href
);
if (control === subject)
  throw new Error(
    "Use a disposable subject checkout, never the control repository",
  );
const commands = [
  ["npm", "ci"],
  ["npm", "ci", "--prefix", "client"],
  ["npm", "run", "typecheck"],
  ["npm", "run", "build"],
  ["npm", "run", "test:unit"],
  ["npm", "--prefix", "client", "run", "test", "--", "--run"],
  ["cargo", "test", "--locked", "-p", "herdr-mise-server", "--lib"],
];
const results = [];
for (let i = 0; i < commands.length; i++) {
  const result = await runCli(commands[i], {
    cwd: subject,
    wallTimeoutMs: 600000,
    idleTimeoutMs: 120000,
    sandbox: {
      mode: "seatbelt",
      required: true,
      provider: "opencode",
      credentialAccess: "isolated",
      profilePath: `${control}/agent-constraints/nightshift-actor.sb`,
    },
  });
  await Deno.writeTextFile(
    `/tmp/nightshift-toolchain-${i}.log`,
    result.stdout + "\n" + result.stderr,
  );
  const row = {
    argv: commands[i],
    code: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  };
  results.push(row);
  console.log(JSON.stringify(row));
  if (!result.success) break;
}
await Deno.writeTextFile(
  "/tmp/nightshift-toolchain-result.json",
  JSON.stringify({ observedAt: new Date().toISOString(), results }, null, 2),
);

if (
  results.length !== commands.length ||
  results.some((row) => row.code !== 0 || row.timedOut)
)
  Deno.exitCode = 1;
