import assert from "node:assert/strict";
import test from "node:test";
import { releaseSummary } from "./discover-herdr-releases.mjs";

test("release discovery reports candidates without trusting upstream markup or changing support", () => {
  const supported = [{ release: "0.9.0" }];
  const report = releaseSummary(
    [
      { tag_name: "v0.9.0", draft: false },
      { tag_name: "v0.10.0-rc.1", draft: false },
      { tag_name: "v9.0.0", draft: true },
      { tag_name: "[untrusted](https://example.invalid)", draft: false },
    ],
    supported,
  );
  assert.match(report, /v0\.9\.0.*supported release/);
  assert.match(report, /v0\.10\.0-rc\.1.*compatibility review required/);
  assert.doesNotMatch(report, /v9\.0\.0|untrusted|example\.invalid/);
  assert.deepEqual(supported, [{ release: "0.9.0" }]);
  assert.throws(() => releaseSummary({}, supported), /release list/);
});
