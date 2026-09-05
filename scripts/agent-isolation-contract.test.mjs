import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

test("automated agent definitions request a fail-closed OS sandbox", () => {
  const directory = "models/@funsaized/cli-agent";
  const files = readdirSync(directory).filter(
    (name) => name.startsWith("nightshift-") && name.endsWith(".yaml"),
  );
  assert.equal(files.length, 8);
  for (const file of files) {
    const definition = readFileSync(`${directory}/${file}`, "utf8");
    assert.match(definition, /^  sandboxMode: auto$/m, file);
    assert.match(definition, /^  sandboxRequired: true$/m, file);
    assert.match(definition, /^  defaultToolProfile: readonly$/m, file);
  }
  const builder = readFileSync(
    "workflows/workflow-nightshift-build.yaml",
    "utf8",
  );
  assert.match(builder, /sandboxMode: auto/);
  assert.match(builder, /sandboxRequired: true/);
  assert.doesNotMatch(builder, /sandboxMode: off|sandboxRequired: false/);
});
