import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const run = (...args) =>
  spawnSync(process.execPath, ["scripts/media/cli.mjs", ...args], {
    encoding: "utf8",
  });
test("media CLI validates arguments before source checks or capture dependencies", () => {
  assert.equal(run("--help").status, 0);
  for (const args of [
    [],
    ["capture", "unknown"],
    ["capture", "web", "--bogus"],
    ["check", "unknown"],
    ["capture", "constructor"],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(
      result.stderr,
      /media capture requires a clean|ffmpeg could not|git failed/,
    );
  }
});
