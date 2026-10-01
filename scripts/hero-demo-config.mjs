// Storyboard for the single README hero GIF: a ~30-second, captioned tour of
// herdr-mise built from the same deterministic visual playground and scene
// actions as the product demo. Import-safe: no processes, files, or network.

import {
  PRODUCT_SCENE_QUERY,
  productSceneClockCeiling,
} from "./product-demo-scenes.mjs";

export const HERO_SCHEMA = "hero-demo-capture-v1";
export const HERO_CAPTURE_PATH = "scripts/hero-demo.capture.json";
export const HERO_PROVENANCE = "deterministic client visual harness hero demo";
export const HERO_DURATION_SECONDS = 30;

const asset = (name) => `docs/assets/${name}`;

export const heroOutputs = Object.freeze({
  gif: { path: asset("herdr-mise-hero.gif"), codec: "gif" },
  mp4: { path: asset("herdr-mise-hero.mp4"), codec: "h264" },
  webm: { path: asset("herdr-mise-hero.webm"), codec: "vp9" },
  poster: { path: asset("herdr-mise-hero-poster.png"), codec: "png" },
});
// Seconds into the hero used for the poster (the mixed-state kitchen).
export const HERO_POSTER_SECONDS = 2;

export const heroStoryboard = Object.freeze([
  {
    start: 0,
    end: 5,
    scene: "states",
    caption: "Every coding agent is a cook: working, idle, blocked, plated.",
  },
  {
    start: 5,
    end: 9,
    scene: "blocked",
    caption: "When an agent needs you, its cook rings the bell.",
  },
  {
    start: 9,
    end: 13,
    scene: "details",
    caption: "Open a station for the exact pane to jump to.",
  },
  {
    start: 13,
    end: 16,
    scene: "workspace",
    caption: "Focus one workspace; blocked work elsewhere stays visible.",
  },
  {
    start: 16,
    end: 20,
    scene: "freezer",
    caption: "Ended sessions rest in the freezer.",
  },
  {
    start: 20,
    end: 24,
    scene: "usage",
    caption: "Recap: observed time blocked, computed locally.",
  },
  {
    start: 24,
    end: 27,
    scene: "comparison",
    caption: "Prefer the terminal? The same kitchen runs as a TUI.",
  },
  {
    start: 27,
    end: 30,
    scene: "installation",
    caption: "herdr-mise · local and read-only.",
  },
]);

/** Clock ceiling per hero scene; blocked frames must stay blocked. */
export function heroClockCeiling(scene) {
  return productSceneClockCeiling(scene);
}

/**
 * Validate the contiguous, ordered hero storyboard covering exactly
 * HERO_DURATION_SECONDS with known scenes and non-empty captions.
 */
export function validateHeroStoryboard(value = heroStoryboard) {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("hero storyboard: expected a non-empty cue list");
  let expectedStart = 0;
  value.forEach((cue, index) => {
    const label = `hero storyboard[${index}]`;
    if (cue.start !== expectedStart)
      throw new Error(`${label}: expected start ${expectedStart}`);
    if (!(cue.end > cue.start))
      throw new Error(`${label}: end must be after start`);
    if (!Object.hasOwn(PRODUCT_SCENE_QUERY, cue.scene))
      throw new Error(`${label}: unknown scene ${cue.scene}`);
    if (typeof cue.caption !== "string" || cue.caption.trim() === "")
      throw new Error(`${label}: caption is required`);
    expectedStart = cue.end;
  });
  if (expectedStart !== HERO_DURATION_SECONDS)
    throw new Error(
      `hero storyboard: expected to end at ${HERO_DURATION_SECONDS}s, got ${expectedStart}s`,
    );
  return value;
}

validateHeroStoryboard();
