import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDurationMs,
  captureFrameCount,
  captureIntervalMs,
  gifFrameRate,
  remainingFrameDelay,
} from "./readme-media-config.mjs";

test("captures a smooth eighteen-second GIF at twenty frames per second", () => {
  assert.equal(gifFrameRate, 20);
  assert.equal(captureFrameCount, 360);
  assert.equal(captureIntervalMs, 50);
  assert.equal(captureFrameCount / gifFrameRate, 18);
  assert.equal(captureDurationMs, 18_000);
});

test("capture pacing compensates for screenshot time without falling behind", () => {
  assert.equal(remainingFrameDelay(1_000, 1, 1_030), 20);
  assert.equal(remainingFrameDelay(1_000, 1, 1_120), 0);
  assert.equal(remainingFrameDelay(1_000, 5, 1_180), 70);
});
