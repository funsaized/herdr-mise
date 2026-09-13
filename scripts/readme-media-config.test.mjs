import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import {
  attentionStoryboard,
  captureDurationMs,
  captureFrameCount,
  captureIntervalMs,
  captureQuery,
  gifFrameRate,
  mediaDurationBoundsSeconds,
  mediaOutputs,
  outputDimensions,
  remainingFrameDelay,
  sourceDimensions,
} from "./readme-media-config.mjs";

test("captures the ordered twelve-second attention story", () => {
  assert.equal(gifFrameRate, 20);
  assert.equal(captureFrameCount, 240);
  assert.equal(captureIntervalMs, 50);
  assert.equal(captureFrameCount / gifFrameRate, 12);
  assert.equal(captureDurationMs, 12_000);
  assert.equal(captureQuery, "preset=attention&agents=6&theme=light");
  assert.deepEqual(
    attentionStoryboard.map(({ atMs, state }) => [atMs, state]),
    [
      [0, "working"],
      [3_000, "blocked"],
      [8_000, "working"],
    ],
  );
  assert.ok(attentionStoryboard.every(({ atMs }) => atMs < captureDurationMs));
});

test("capture pacing compensates for screenshot time without falling behind", () => {
  assert.equal(remainingFrameDelay(1_000, 1, 1_030), 20);
  assert.equal(remainingFrameDelay(1_000, 1, 1_120), 0);
  assert.equal(remainingFrameDelay(1_000, 5, 1_180), 70);
});

test("checked-in web metadata matches every checked-in output", async () => {
  const metadata = JSON.parse(await readFile("scripts/web-demo.capture.json"));
  assert.equal(metadata.schema, "web-demo-capture-v1");
  assert.match(metadata.sourceCommit, /^[0-9a-f]{40}$/);
  const sourceCommit = spawnSync(
    "git",
    ["cat-file", "-e", `${metadata.sourceCommit}^{commit}`],
    { encoding: "utf8" },
  );
  assert.equal(sourceCommit.status, 0, sourceCommit.stderr);
  const storyboard = spawnSync(
    "git",
    [
      "cat-file",
      "-e",
      `${metadata.sourceCommit}:client/src/attention-story.json`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    storyboard.status,
    0,
    `${metadata.sourceCommit} lacks storyboard`,
  );
  const implementation = spawnSync(
    "git",
    [
      "grep",
      "-q",
      "attentionTiming",
      metadata.sourceCommit,
      "--",
      "client/src/visual-harness.ts",
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    implementation.status,
    0,
    `${metadata.sourceCommit} lacks attention implementation`,
  );
  assert.equal(metadata.query, captureQuery);
  assert.deepEqual(metadata.scenario, attentionStoryboard);
  assert.deepEqual(metadata.semanticStatesObserved, [
    "working",
    "blocked",
    "working",
  ]);
  assert.deepEqual(metadata.sourceDimensions, sourceDimensions);
  assert.deepEqual(metadata.outputDimensions, outputDimensions);
  assert.equal(metadata.durationSeconds, captureDurationMs / 1_000);

  for (const [key, config] of Object.entries(mediaOutputs)) {
    const recorded = metadata.outputs[key],
      bytes = await readFile(config.path),
      file = await stat(config.path);
    assert.equal(recorded.path, config.path);
    assert.equal(recorded.codec, config.codec);
    assert.equal(recorded.bytes, file.size);
    assert.equal(
      recorded.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    if (key !== "poster") {
      assert.ok(
        recorded.durationSeconds >= mediaDurationBoundsSeconds.min &&
          recorded.durationSeconds <= mediaDurationBoundsSeconds.max,
      );
    }
  }
});

test("README embeds no animated GIF", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.doesNotMatch(readme, /!\[[^\]]*\]\([^)]*\.gif(?:\?[^)]*)?\)/i);
});
