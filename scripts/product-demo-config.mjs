// Authoritative storyboard for the 75-second herdr-mise product demo and its
// three rebased feature loops. The capture owns frame pacing and encoding;
// this module owns editorial timing, captions, VTT/transcript rendering, and
// the version label so the capture, validator, and browser tests cannot drift.
//
// The installation cue's caption is editorial copy. The capture replaces it
// with `versionLabel(readSourceVersion(root), sourceCommit)` before rendering
// and records that exact label in the capture metadata; `validateProductMedia`
// then checks the rendered caption equals the metadata label.

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  PRODUCT_MAIN_DURATION_SECONDS,
  PRODUCT_INSTALL_COMMANDS,
  PRODUCT_SCENES,
} from "./product-demo-scenes.mjs";

export const PRODUCT_DEMO_SCHEMA = "product-demo-capture-v1";
export const PRODUCT_DEMO_CAPTURE_PATH = "scripts/product-demo.capture.json";
export const PRODUCT_DEMO_PROVENANCE =
  "deterministic client visual harness product demo";

export const frameRate = 20;
export const outputDimensions = Object.freeze({ width: 960, height: 540 });
export const sourceDimensions = Object.freeze({ width: 1280, height: 720 });
// Container/codec rounding budget around an exact frame timeline.
export const durationToleranceSeconds = 0.25;

// The prerecorded comparison scene reuses this input; its original capture
// provenance must survive into the product metadata unchanged.
export const TUI_DEMO_INPUT = Object.freeze({
  path: "docs/assets/herdr-mise-tui-demo.gif",
  capturePath: "scripts/tui-demo.capture.json",
});

export const storyboard = Object.freeze([
  {
    start: 0,
    end: 10,
    scene: "busy",
    caption: "Six cooks working the lunch service.",
  },
  {
    start: 10,
    end: 20,
    scene: "blocked",
    caption: "Codex is blocked on checkout-api, waiting for a human.",
  },
  {
    start: 20,
    end: 32,
    scene: "details",
    caption: "Open details to read the exact pane locator.",
  },
  {
    start: 32,
    end: 44,
    scene: "workspace",
    caption: "Scope the kitchen to one local workspace.",
  },
  {
    start: 44,
    end: 56,
    scene: "comparison",
    caption: "Prerecorded TUI demo, not a live terminal.",
  },
  {
    start: 56,
    end: 66,
    scene: "recap",
    caption: "Observed time blocked, computed locally.",
  },
  {
    start: 66,
    end: 75,
    scene: "installation",
    caption: "herdr-mise · install the Herdr plugin, then open the kitchen.",
  },
]);

const asset = (name) => `docs/assets/${name}`;

function outputSet(id, { gif = false } = {}) {
  return Object.freeze({
    mp4: { path: asset(`${id}.mp4`), codec: "h264", duration: true },
    webm: { path: asset(`${id}.webm`), codec: "vp9", duration: true },
    poster: { path: asset(`${id}-poster.png`), codec: "png", duration: false },
    vtt: { path: asset(`${id}.vtt`), codec: "webvtt", text: true },
    txt: { path: asset(`${id}.txt`), codec: "text", text: true },
    ...(gif
      ? { gif: { path: asset(`${id}.gif`), codec: "gif", duration: true } }
      : {}),
  });
}

export const deliverables = Object.freeze([
  Object.freeze({
    id: "herdr-mise-product-demo",
    title: "herdr-mise product demo",
    kind: "main",
    start: 0,
    end: PRODUCT_MAIN_DURATION_SECONDS,
    durationSeconds: PRODUCT_MAIN_DURATION_SECONDS,
    posterSeconds: 21,
    loop: false,
    scenes: Object.freeze([...PRODUCT_SCENES]),
    outputs: outputSet("herdr-mise-product-demo"),
  }),
  Object.freeze({
    id: "feature-attention",
    title: "Feature: blocked attention",
    kind: "loop",
    start: 10,
    end: 32,
    durationSeconds: 22,
    posterSeconds: 11,
    loop: true,
    scenes: Object.freeze(["blocked", "details"]),
    outputs: outputSet("herdr-mise-feature-attention", { gif: true }),
  }),
  Object.freeze({
    id: "feature-workspace",
    title: "Feature: workspace scope",
    kind: "loop",
    start: 32,
    end: 44,
    durationSeconds: 12,
    posterSeconds: 2,
    loop: true,
    scenes: Object.freeze(["workspace"]),
    outputs: outputSet("herdr-mise-feature-workspace", { gif: true }),
  }),
  Object.freeze({
    id: "feature-presentation",
    title: "Feature: prerecorded TUI",
    kind: "loop",
    start: 44,
    end: 56,
    durationSeconds: 12,
    posterSeconds: 2,
    loop: true,
    scenes: Object.freeze(["comparison"]),
    outputs: outputSet("herdr-mise-feature-presentation", { gif: true }),
  }),
]);

export function readSourceVersion(root) {
  // Keep the storyboard importable by Playwright's CommonJS test loader;
  // release-policy's executable entry point uses import.meta.
  const cargo = readFileSync(resolve(root, "server", "Cargo.toml"), "utf8");
  const block = cargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  const version = block?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) throw new Error("server/Cargo.toml package version is missing");
  return version;
}

export function versionLabel(version, commit) {
  if (typeof version !== "string" || version.trim() === "")
    throw new Error("versionLabel: a package version is required");
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/.test(commit))
    throw new Error(
      `versionLabel: invalid source commit ${JSON.stringify(commit)}`,
    );
  return `herdr-mise ${version.trim()} · source ${commit.slice(0, 7)}`;
}

function resolveDeliverable(clip) {
  const id = typeof clip === "string" ? clip : clip?.id;
  const found = deliverables.find((deliverable) => deliverable.id === id);
  if (!found)
    throw new Error(`unknown product demo clip ${JSON.stringify(id)}`);
  return found;
}

/**
 * Storyboard cues for one deliverable, rebased so a loop starts at zero.
 *
 * @param {string | { id: string }} clip deliverable id or descriptor
 * @param {ReadonlyArray<{start:number,end:number,scene:string,caption:string}>} [source]
 */
export function cuesFor(clip, source = storyboard) {
  validateStoryboard(source);
  const deliverable = resolveDeliverable(clip);
  return source
    .filter((cue) => deliverable.scenes.includes(cue.scene))
    .map((cue, index) => {
      if (cue.start < deliverable.start || cue.end > deliverable.end)
        throw new Error(
          `${deliverable.id}: ${cue.scene} cue extends past the clip`,
        );
      return {
        index: index + 1,
        start: cue.start - deliverable.start,
        end: cue.end - deliverable.start,
        scene: cue.scene,
        text: cue.caption,
      };
    });
}

function vttTimestamp(seconds) {
  const total = Math.round(seconds * 1000);
  const milliseconds = total % 1000;
  const wholeSeconds = (total - milliseconds) / 1000;
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(Math.floor(wholeSeconds / 3600))}:${pad(
    Math.floor(wholeSeconds / 60) % 60,
  )}:${pad(wholeSeconds % 60)}.${String(milliseconds).padStart(3, "0")}`;
}

function clock(seconds) {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function webVtt(clip, source = storyboard) {
  const body = cuesFor(clip, source)
    .map(
      (cue) =>
        `${cue.index}\n${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}\n${cue.text}`,
    )
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

export function transcript(clip, label, source = storyboard) {
  if (typeof label !== "string" || label.trim() === "")
    throw new Error("transcript: a provenance label is required");
  const deliverable = resolveDeliverable(clip);
  const lines = [
    deliverable.title,
    label,
    `${deliverable.durationSeconds}s · ${frameRate} fps · ${outputDimensions.width}×${outputDimensions.height}`,
    "",
  ];
  for (const cue of cuesFor(deliverable, source)) {
    lines.push(`${clock(cue.start)}–${clock(cue.end)}  ${cue.text}`);
    if (cue.scene === "installation")
      for (const command of PRODUCT_INSTALL_COMMANDS)
        lines.push(`             $ ${command}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Validate the contiguous, ordered, in-bounds storyboard shape.
 *
 * @param {unknown} value
 * @returns {ReadonlyArray<{start:number,end:number,scene:string,caption:string}>}
 */
export function validateStoryboard(value) {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("storyboard: expected a non-empty cue list");
  let expectedStart = 0;
  value.forEach((cue, index) => {
    const label = `storyboard[${index}]`;
    if (cue === null || typeof cue !== "object")
      throw new Error(`${label}: expected a cue object`);
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end))
      throw new Error(`${label}: start and end must be finite seconds`);
    if (cue.start !== expectedStart)
      throw new Error(
        `${label}: expected start ${expectedStart}, got ${cue.start}`,
      );
    if (cue.end <= cue.start)
      throw new Error(`${label}: end must be after start`);
    if (!PRODUCT_SCENES.includes(cue.scene))
      throw new Error(`${label}: unknown scene ${cue.scene}`);
    if (typeof cue.caption !== "string" || cue.caption.trim() === "")
      throw new Error(`${label}: caption is required`);
    if (cue.end > PRODUCT_MAIN_DURATION_SECONDS)
      throw new Error(
        `${label}: cue extends past ${PRODUCT_MAIN_DURATION_SECONDS}s`,
      );
    expectedStart = cue.end;
  });
  if (expectedStart !== PRODUCT_MAIN_DURATION_SECONDS)
    throw new Error(
      `storyboard: expected to end at ${PRODUCT_MAIN_DURATION_SECONDS}s, got ${expectedStart}s`,
    );
  const scenes = value.map((cue) => cue.scene).join(",");
  if (scenes !== PRODUCT_SCENES.join(","))
    throw new Error("storyboard: scenes must follow the approved order");
  return value;
}

// Keep the import graph self-checking: a malformed edit fails at import rather
// than at capture time.
validateStoryboard(storyboard);
