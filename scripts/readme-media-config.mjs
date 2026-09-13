import attentionTiming from "../client/src/attention-story.json" with { type: "json" };

export const gifFrameRate = 20;
export const captureDurationMs = 12_000;
export const mediaDurationBoundsSeconds = { min: 10, max: 15 };
export const captureIntervalMs = 1_000 / gifFrameRate;
export const captureFrameCount = captureDurationMs / captureIntervalMs;
export const captureQuery = "preset=attention&agents=6&theme=light";
export const sourceDimensions = { width: 1280, height: 720 };
export const outputDimensions = { width: 960, height: 540 };
export const attentionStoryboard = [
  { atMs: 0, state: "working", caption: "Six cooks are working." },
  {
    atMs: attentionTiming.blockedAtMs,
    state: "blocked",
    caption: "Codex is blocked on checkout-api.",
  },
  {
    atMs: attentionTiming.resumedAtMs,
    state: "working",
    caption: "Codex resumed work on checkout-api.",
  },
];
export const mediaOutputs = {
  gif: { path: "docs/assets/herdr-mise-demo.gif", codec: "gif" },
  mp4: { path: "docs/assets/herdr-mise-demo.mp4", codec: "h264" },
  webm: { path: "docs/assets/herdr-mise-demo.webm", codec: "vp9" },
  poster: {
    path: "docs/assets/herdr-mise-demo-poster.png",
    codec: "png",
  },
};

export function remainingFrameDelay(startedAt, completedFrames, now) {
  return Math.max(0, startedAt + completedFrames * captureIntervalMs - now);
}
