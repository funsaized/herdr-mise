import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const owned = new Map();

// Suite teardown also runs after assertion failures. Exit/signal handlers cover
// interruption; SIGKILL and host crashes cannot run cleanup.
function cleanup() {
  const errors = [];
  for (const [root, stop] of owned) {
    owned.delete(root);
    try {
      stop();
      if (process.env.HERDR_MISE_KEEP_TEST_TEMP === "1")
        console.error(`Retained test directory: ${root}`);
      else rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.error(`Test cleanup failed; retained ${root}`);
      errors.push(error);
    }
  }
  if (errors.length) {
    process.exitCode = 1;
    throw new AggregateError(errors, "Test cleanup failed");
  }
}

after(cleanup);
process.once("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    try {
      cleanup();
    } finally {
      process.kill(process.pid, signal);
    }
  });
}

// Register ownership immediately, before fixture setup can throw. A synchronous
// stop callback runs before deletion even when preserving files for debugging.
export function testTempDir(prefix, stop = () => {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  owned.set(root, stop);
  return root;
}
