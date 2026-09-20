/** Repository policy layered on the installed CLI-agent execution path. */
import { z } from "npm:zod@4.4.3";
import { toFileUrl } from "jsr:@std/path@1.1.2";
import { subjectRoot } from "./subject_root.ts";
// Load the installed integration only at execution time. Clean subject checkouts
// intentionally do not contain Swamp's restored extension sources.
async function installedAgent(repoDir: string) {
  const path = `${await Deno.realPath(repoDir)}/.swamp/pulled-extensions/@funsaized/cli-agent/models/cli_agent.ts`;
  return await import(toFileUrl(path).href);
}

const Arguments = z.object({
  prompt: z.string(),
  invocationId: z.string().min(1),
  cwd: z.string().min(1).optional(),
  opencodeAgent: z.string().min(1),
  tags: z.record(z.string(), z.string()).optional(),
});
type AgentContext = {
  repoDir: string;
  globalArgs: {
    defaultProvider: string;
    defaultToolProfile: "actor" | "readonly";
    [key: string]: unknown;
  };
  writeResource: (
    spec: string,
    name: string,
    value: unknown,
  ) => Promise<unknown>;
};

export async function macosProfile(root: string, role: "actor" | "readonly") {
  const path = `${await Deno.realPath(root)}/agent-constraints/nightshift-${role}.sb`;
  if (
    (await Deno.lstat(path)).isSymlink ||
    (await Deno.realPath(path)) !== path
  )
    throw new Error("Sandbox policy must not be a symlink");
  await Deno.readTextFile(path);
  return path;
}

/** Dummy fixtures only: no provider invocation or real credential access. */
export async function probeMacosSandbox(repoDir: string) {
  if (Deno.build.os !== "darwin")
    throw new Error("macOS sandbox acceptance requires Darwin");
  const { wrapWithSandbox } = await installedAgent(repoDir);
  const root = await Deno.realPath(await Deno.makeTempDir());
  const home = `${root}/home`;
  const cwd = `${home}/subject`;
  const checks: Record<string, boolean> = {};
  const profiles: Record<string, string> = {};
  try {
    await Deno.mkdir(`${home}/.ssh`, { recursive: true });
    await Deno.mkdir(`${home}/Library/Keychains`, { recursive: true });
    await Deno.mkdir(`${home}/.local/share/opencode`, { recursive: true });
    await Deno.mkdir(cwd);
    await Deno.writeTextFile(`${home}/.ssh/canary`, "dummy");
    await Deno.writeTextFile(
      `${home}/Library/Keychains/login.keychain-db`,
      "dummy",
    );
    await Deno.writeTextFile(`${cwd}/source`, "source");
    await Deno.writeTextFile(
      `${home}/.local/share/opencode/auth.json`,
      "dummy-provider",
    );
    await Deno.symlink(`${cwd}/source`, `${root}/source-link`);
    for (const role of ["readonly", "actor"] as const) {
      const profilePath = await macosProfile(repoDir, role);
      profiles[role] = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            await Deno.readFile(profilePath),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const config = {
        mode: "seatbelt" as const,
        provider: "opencode" as const,
        credentialAccess: "provider" as const,
        required: true,
        profilePath,
      };
      const run = async (command: string[]) => {
        // Use the real provider launch wrapper with a fixture HOME parameter.
        const wrapped = wrapWithSandbox(command, cwd, config).map(
          (arg: string) => {
            if (arg.startsWith("HOME=")) return `HOME=${home}`;
            if (arg.startsWith("CREDENTIAL_FILE_"))
              return arg.replace(`${Deno.env.get("HOME")}/`, `${home}/`);
            return arg;
          },
        );
        const result = await new Deno.Command(wrapped[0], {
          args: wrapped.slice(1),
          cwd,
          stdout: "null",
          stderr: "null",
        }).output();
        return result.success;
      };
      checks[`${role}:source-readable`] = await run([
        "/bin/cat",
        `${cwd}/source`,
      ]);
      checks[`${role}:ssh-denied`] = !(await run([
        "/bin/cat",
        `${home}/.ssh/canary`,
      ]));
      checks[`${role}:keychain-denied`] = !(await run([
        "/bin/cat",
        `${home}/Library/Keychains/login.keychain-db`,
      ]));
      checks[`${role}:source-write`] =
        (await run(["/usr/bin/touch", `${cwd}/source`])) === (role === "actor");
      checks[`${role}:symlink-write`] =
        (await run(["/usr/bin/touch", `${root}/source-link`])) ===
        (role === "actor");
      checks[`${role}:provider-login-readable`] = await run([
        "/bin/cat",
        `${home}/.local/share/opencode/auth.json`,
      ]);
      await Deno.writeTextFile(`${cwd}/rename-me`, "dummy");
      checks[`${role}:rename`] =
        (await run(["/bin/mv", `${cwd}/rename-me`, `${cwd}/renamed`])) ===
        (role === "actor");
      await Deno.writeTextFile(`${cwd}/delete-me`, "dummy");
      checks[`${role}:deletion`] =
        (await run(["/bin/rm", `${cwd}/delete-me`])) === (role === "actor");
      const testFile = `${cwd}/${role}.test.mjs`;
      await Deno.writeTextFile(
        testFile,
        `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { readFileSync, writeFileSync } from 'node:fs';
        test('sandboxed source and output access', () => {
          assert.equal(readFileSync('source', 'utf8'), 'source');
          const write = () => writeFileSync('test-output', 'generated');
          ${role === "actor" ? "write(); assert.equal(readFileSync('test-output', 'utf8'), 'generated');" : "assert.throws(write);"}
        });
      `,
      );
      checks[`${role}:node-tests`] = await run(["node", "--test", testFile]);
      // Fixture lives under temporary storage, so this case verifies the
      // explicit read-only subject rule despite the broad temporary carve-out.
      try {
        wrapWithSandbox(
          ["/usr/bin/true"],
          cwd,
          config,
          undefined,
          `${root}/missing-backend`,
        );
        checks[`${role}:missing-backend-denied`] = false;
      } catch {
        checks[`${role}:missing-backend-denied`] = true;
      }
    }
    return {
      backend: "seatbelt",
      observedAt: new Date().toISOString(),
      profiles,
      checks,
      passed: Object.values(checks).every(Boolean),
      limits: [
        "Provider authentication and network not tested",
        "Shared temporary storage and provider state",
        "No VM or complete home-read isolation",
      ],
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

export const extension = {
  type: "@funsaized/cli-agent",
  resources: {
    macosSandboxProbe: {
      description:
        "Observed native sandbox canaries, policy hashes and explicit limits",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "30d",
      garbageCollection: 100,
    },
  },
  methods: [
    {
      invoke_nightshift: {
        description:
          "Invoke and parse with required OS sandboxing and trusted macOS role policy",
        arguments: Arguments,
        execute: async (
          args: z.infer<typeof Arguments>,
          context: AgentContext,
        ) => {
          const { model: cliAgent } = await installedAgent(context.repoDir);
          const cwd = await subjectRoot(
            context.repoDir,
            args.cwd ?? context.repoDir,
          );
          const role = context.globalArgs.defaultToolProfile;
          if (
            role === "actor" &&
            cwd === (await Deno.realPath(context.repoDir))
          )
            throw new Error(
              "Actors require a separate subject checkout; the launcher must remain protected",
            );
          const parsed = cliAgent.methods.invokeAndParse.arguments.parse({
            ...args,
            cwd,
          });
          if (Deno.build.os !== "darwin") {
            return await cliAgent.methods.invokeAndParse.execute(
              { ...parsed, sandboxMode: "auto", sandboxRequired: true },
              context,
            );
          }
          if (context.globalArgs.defaultProvider !== "opencode")
            throw new Error(
              "Nightshift macOS policy currently supports the OpenCode route only",
            );
          const profile = await macosProfile(context.repoDir, role);
          const evidence = await probeMacosSandbox(context.repoDir);
          await context.writeResource("macosSandboxProbe", "macos-sandbox", {
            ...evidence,
            invocationId: args.invocationId,
            agent: args.opencodeAgent,
            role,
            subjectRoot: cwd,
          });
          if (!evidence.passed)
            throw new Error("macOS sandbox canary failed before agent launch");
          return await cliAgent.methods.invokeAndParse.execute(
            {
              ...parsed,
              sandboxMode: "seatbelt",
              sandboxRequired: true,
              sandboxNetwork: "allow",
            },
            {
              ...context,
              globalArgs: { ...context.globalArgs, sandboxProfile: profile },
            },
          );
        },
      },
      check_macos_sandbox: {
        description:
          "Exercise the installed Seatbelt launcher with dummy fixtures, without launching an agent",
        arguments: z.object({}),
        execute: async (_args: unknown, context: AgentContext) => {
          const evidence = await probeMacosSandbox(context.repoDir);
          const handle = await context.writeResource(
            "macosSandboxProbe",
            "macos-sandbox",
            evidence,
          );
          if (!evidence.passed)
            throw new Error(
              "macOS sandbox canary failed; inspect macos-sandbox evidence",
            );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
