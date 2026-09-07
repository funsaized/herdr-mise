import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { runJson, stopChild } from "./lib/swamp-test-process.mjs";

test("async tool failures reject with stdout and stderr instead of escaping callbacks", async () => {
  await assert.rejects(runJson("/nonexistent/factory-tool", []), /ENOENT/);
  await assert.rejects(
    runJson(process.execPath, [
      "-e",
      "console.log('not json');console.error('diagnostic');process.exit(1)",
    ]),
    /stdout:[\s\S]*not json[\s\S]*stderr:[\s\S]*diagnostic/,
  );
  const result = await runJson(process.execPath, [
    "-e",
    "console.log('progress');console.log(JSON.stringify({ok:true}))",
  ]);
  assert.deepEqual(result.json, { ok: true });
});

test("server cleanup waits for child close and releases its timeout", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await once(child.stdout, "data");
  await stopChild(child);
  assert.notEqual(child.signalCode, null);
  await stopChild(child);
});
