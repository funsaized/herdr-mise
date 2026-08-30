import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("verifies every frame of the checked-in live Herdr split", () => {
  const result = spawnSync(
    "bash",
    ["scripts/capture-tui-demo.sh", "--verify-only"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified checked-in live split/);
});
