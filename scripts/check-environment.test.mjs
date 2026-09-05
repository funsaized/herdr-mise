import assert from "node:assert/strict";
import test from "node:test";
import { dependencyDrift } from "./check-environment.mjs";

test("environment preflight identifies a stale installed test runner", () => {
  const read = (path) =>
    path.endsWith("package-lock.json")
      ? { packages: { "node_modules/vitest": { version: "4.1.11" } } }
      : path.includes("node_modules")
        ? { version: "3.2.7" }
        : { devDependencies: { vitest: "^4.1.11" } };
  const errors = dependencyDrift("/example", read);
  assert.equal(errors.length, 2);
  assert.match(
    errors[1],
    /installed 3.2.7, locked 4.1.11; run npm ci --prefix client/,
  );
});
