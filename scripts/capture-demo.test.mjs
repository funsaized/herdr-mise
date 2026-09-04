import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("demo recorder requires a capture mode", () => {
  const result = spawnSync("/bin/bash", ["scripts/capture-demo.sh"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /capture-demo\.sh tui\|web/);
});
