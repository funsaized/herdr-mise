export const gifFrameRate = 20;
export const captureDurationMs = 10_000;
export const captureIntervalMs = 1_000 / gifFrameRate;
export const captureFrameCount = captureDurationMs / captureIntervalMs;

export function remainingFrameDelay(startedAt, completedFrames, now) {
  return Math.max(0, startedAt + completedFrames * captureIntervalMs - now);
}
