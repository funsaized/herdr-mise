import assert from "node:assert/strict";
import test from "node:test";
import {
  TARGETS,
  assetUrl,
  parseSidecar,
  updateFormula,
} from "./homebrew-formula.mjs";

const sha = (digit) => digit.repeat(64);
const formula = `class HerdrMise < Formula
  if OS.mac? && Hardware::CPU.arm?
    url "${assetUrl("v0.2.0", TARGETS[0])}"
    sha256 "${sha("1")}"
  elsif OS.mac?
    url "${assetUrl("v0.2.0", TARGETS[1])}"
    sha256 "${sha("2")}"
  else
    url "${assetUrl("v0.2.0", TARGETS[2])}"
    sha256 "${sha("3")}"
  end
end
`;
const checksums = Object.fromEntries(
  TARGETS.map((target, index) => [target, sha("abc"[index])]),
);

test("formula update rewrites exactly the three url and sha256 pairs", () => {
  const updated = updateFormula(formula, "v0.3.0", checksums);
  for (const target of TARGETS) {
    assert.ok(
      updated.includes(
        `url "${assetUrl("v0.3.0", target)}"\n    sha256 "${checksums[target]}"`,
      ),
    );
  }
  assert.doesNotMatch(updated, /v0\.2\.0/);
  assert.equal(updated.split("\n").length, formula.split("\n").length);
});

test("formula update rejects prereleases, bad checksums, and ambiguous formulas", () => {
  assert.throws(
    () => updateFormula(formula, "v0.3.0-rc.1", checksums),
    /stable/,
  );
  assert.throws(
    () =>
      updateFormula(formula, "v0.3.0", { ...checksums, [TARGETS[1]]: "short" }),
    /malformed sha256/,
  );
  const duplicated = formula.replace(
    assetUrl("v0.2.0", TARGETS[1]),
    assetUrl("v0.2.0", TARGETS[0]),
  );
  assert.throws(
    () => updateFormula(duplicated, "v0.3.0", checksums),
    /expected one/,
  );
});

test("sidecars must name exactly the expected archive", () => {
  const name = `herdr-mise-v0.3.0-${TARGETS[0]}.tar.gz`;
  assert.equal(
    parseSidecar(`${sha("c")}  ${name}\n`, "v0.3.0", TARGETS[0]),
    sha("c"),
  );
  assert.throws(() =>
    parseSidecar(`${sha("c")}  other.tar.gz`, "v0.3.0", TARGETS[0]),
  );
  assert.throws(() => parseSidecar(`nothex  ${name}`, "v0.3.0", TARGETS[0]));
});
