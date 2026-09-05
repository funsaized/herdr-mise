import assert from "node:assert/strict";
import test from "node:test";
import { prepareAcceptance } from "./prepare-acceptance.mjs";
const rc = {
  tag: "v0.3.0-rc.1",
  version: "0.3.0-rc.1",
  commit: "a".repeat(40),
  artifacts: [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
  ].map((target) => ({
    target,
    archive: `herdr-mise-v0.3.0-rc.1-${target}.tar.gz`,
    sha256: "b".repeat(64),
  })),
};
test("future release preparation changes identity data, not gate logic", () => {
  const contract = prepareAcceptance("v0.3.0", rc);
  assert.equal(contract.acceptedRcTag, rc.tag);
  assert.equal(Object.keys(contract.artifacts).length, 3);
  assert.throws(() => prepareAcceptance("v0.4.0", rc), /exact RC/);
  assert.throws(
    () =>
      prepareAcceptance("v0.3.0", {
        ...rc,
        artifacts: [rc.artifacts[0], rc.artifacts[0], rc.artifacts[2]],
      }),
    /distinct/,
  );
});
