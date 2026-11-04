import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const helper = new URL("./test-temp.mjs", import.meta.url).href;
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), "mise-cleanup-regression-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return {
    parent,
    env: { ...process.env, TMPDIR: parent, HERDR_MISE_KEEP_TEST_TEMP: "0" },
  };
}

for (const fail of [false, true]) {
  test(`temporary fixtures are removed after ${fail ? "failure" : "success"}`, (t) => {
    const { parent, env } = fixture(t);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import test from 'node:test';
      import { testTempDir } from ${JSON.stringify(helper)};
      test('fixture setup', () => {
        testTempDir('owned-');
        if (${fail}) throw new Error('intentional fixture failure');
      });
    `,
      ],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    assert.deepEqual(readdirSync(parent), []);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(
    `temporary fixtures stop owned resources before ${signal} cleanup`,
    { timeout: 10_000 },
    async (t) => {
      const { parent, env } = fixture(t);
      const marker = join(parent, "stopped");
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import test from 'node:test';
      import { writeFileSync, existsSync } from 'node:fs';
      import { testTempDir } from ${JSON.stringify(helper)};
      test('interrupted fixture', async () => {
        const root = testTempDir('owned-', () => {
          if (!existsSync(root)) throw new Error('deleted before stop');
          writeFileSync(${JSON.stringify(marker)}, 'stopped');
        });
        setInterval(() => {}, 1000);
        console.log('ready');
        await new Promise(() => {});
      });
    `,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close");
          child.kill("SIGKILL");
          await closed;
        }
      });
      const closed = once(child, "close");
      await once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
      child.kill(signal);
      const [code, received] = await closed;
      assert.equal(code, null);
      assert.equal(received, signal);
      assert.ok(existsSync(marker));
      assert.deepEqual(readdirSync(parent), ["stopped"]);
    },
  );
}

test("debug retention still stops owned resources", (t) => {
  const { parent, env } = fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import test from 'node:test';
    import { writeFileSync } from 'node:fs';
    import { testTempDir } from ${JSON.stringify(helper)};
    test('retained fixture', () => {
      const root = testTempDir('owned-', () => writeFileSync(root + '/stopped', 'yes'));
    });
  `,
    ],
    {
      env: { ...env, HERDR_MISE_KEEP_TEST_TEMP: "1" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Retained test directory:/);
  const [root] = readdirSync(parent);
  assert.ok(existsSync(join(parent, root, "stopped")));
});

test("cleanup failure retains evidence, fails the run, and cleans other fixtures", (t) => {
  const { parent, env } = fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import test from 'node:test';
      import { testTempDir } from ${JSON.stringify(helper)};
      test('failed stop', () => {
        testTempDir('retained-', () => { throw new Error('stop failed'); });
        testTempDir('removed-');
      });
    `,
    ],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Test cleanup failed; retained/);
  assert.equal(readdirSync(parent).length, 1);
  assert.match(readdirSync(parent)[0], /^retained-/);
});
