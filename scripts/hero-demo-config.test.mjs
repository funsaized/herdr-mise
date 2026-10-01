import assert from "node:assert/strict";
import test from "node:test";
import {
  HERO_DURATION_SECONDS,
  heroOutputs,
  heroStoryboard,
  validateHeroStoryboard,
} from "./hero-demo-config.mjs";
import { PRODUCT_SCENE_QUERY } from "./product-demo-scenes.mjs";

test("hero storyboard tours every product surface in thirty seconds", () => {
  validateHeroStoryboard();
  assert.equal(heroStoryboard.at(-1).end, HERO_DURATION_SECONDS);
  const scenes = heroStoryboard.map((cue) => cue.scene);
  for (const scene of [
    "states",
    "blocked",
    "details",
    "workspace",
    "freezer",
    "usage",
    "comparison",
    "installation",
  ])
    assert.ok(scenes.includes(scene), `hero is missing ${scene}`);
  for (const scene of scenes) assert.ok(PRODUCT_SCENE_QUERY[scene]);
  assert.equal(heroOutputs.gif.path, "docs/assets/herdr-mise-hero.gif");
  assert.throws(() =>
    validateHeroStoryboard([{ start: 0, end: 5, scene: "nope", caption: "x" }]),
  );
  assert.throws(() =>
    validateHeroStoryboard([
      { start: 0, end: 5, scene: "states", caption: "x" },
    ]),
  );
});
