import { toFileUrl } from "jsr:@std/path@1.1.2";
const control = await Deno.realPath(Deno.args[0]);
const { runCli } = await import(
  toFileUrl(
    `${control}/.swamp/pulled-extensions/@funsaized/cli-agent/models/cli_agent.ts`,
  ).href
);
const root = await Deno.realPath(
  await Deno.makeTempDir({ prefix: "ns-broker-" }),
);
const home = `${root}/home`;
const subject = `${root}/subject`;
await Deno.mkdir(`${home}/Library/Keychains`, { recursive: true });
await Deno.mkdir(subject);
const keychain = `${home}/Library/Keychains/fixture.keychain-db`;
const rows = [];
async function host(args: string[]) {
  const r = await new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!r.success)
    throw new Error(`${args[0]}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout);
}
let created = false;
try {
  await host([
    "/usr/bin/security",
    "create-keychain",
    "-p",
    "nightshift-fixture-only",
    keychain,
  ]);
  created = true;
  await host([
    "/usr/bin/security",
    "add-generic-password",
    "-a",
    "nightshift-fixture",
    "-s",
    "nightshift-fixture",
    "-w",
    "dummy-value",
    "-A",
    keychain,
  ]);
  const baseline = await host([
    "/usr/bin/security",
    "find-generic-password",
    "-a",
    "nightshift-fixture",
    "-s",
    "nightshift-fixture",
    "-w",
    keychain,
  ]);
  rows.push({
    role: "host",
    check: "dummy-keychain-readable",
    passed: baseline.trim() === "dummy-value",
  });
  for (const role of ["readonly", "actor"]) {
    // Replace only policy parameters with fixture HOME; real credential files are never queried.
    const policy = (
      await Deno.readTextFile(
        `${control}/agent-constraints/nightshift-${role}.sb`,
      )
    ).replace('(define HOME (param "HOME"))', `(define HOME "${home}")`);
    const profile = `${root}/${role}.sb`;
    await Deno.writeTextFile(profile, policy);
    for (const [check, argv] of [
      ["direct-keychain-file", ["/bin/cat", keychain]],
      [
        "keychain-broker",
        [
          "/usr/bin/security",
          "find-generic-password",
          "-a",
          "nightshift-fixture",
          "-s",
          "nightshift-fixture",
          "-w",
          keychain,
        ],
      ],
    ] as const) {
      const r = await runCli([...argv], {
        cwd: subject,
        wallTimeoutMs: 15000,
        idleTimeoutMs: 0,
        sandbox: {
          mode: "seatbelt",
          required: true,
          provider: "opencode",
          credentialAccess: "isolated",
          profilePath: profile,
        },
      });
      rows.push({
        role,
        check,
        code: r.code,
        timedOut: r.timedOut,
        readDummy: r.stdout.trim() === "dummy-value",
      });
    }
  }
} finally {
  if (created) await host(["/usr/bin/security", "delete-keychain", keychain]);
  await Deno.remove(root, { recursive: true });
}
console.log(
  JSON.stringify(
    { observedAt: new Date().toISOString(), results: rows },
    null,
    2,
  ),
);

if (
  rows.some((row) =>
    row.role === "host"
      ? !row.passed
      : row.code === 0 || row.readDummy || row.timedOut,
  )
)
  Deno.exitCode = 1;
