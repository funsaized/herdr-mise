// Validate the headless TUI demo (`scripts/tui-demo.capture.json`) against the
// storyboard and every file it references. `validateTuiMedia` is import-safe
// and takes injected IO so tests can exercise it without ffmpeg; the capture
// script runs it on the staged package before anything is published, and
// `node scripts/check-tui-media.mjs` checks the checked-in package.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TUI_DEMO_CAPTURE_PATH,
  TUI_DEMO_DURATION_SECONDS,
  TUI_DEMO_SCHEMA,
  TUI_DURATION_TOLERANCE_SECONDS,
  TUI_FRAME_RATE,
  TUI_GIF_WIDTH,
  TUI_MEDIA_BUDGET_BYTES,
  tuiCanvas,
  tuiOutputs,
  tuiStoryboard,
  tuiTranscript,
  tuiWebVtt,
} from "./tui-demo-config.mjs";

function requireCondition(condition, source, message) {
  if (!condition) throw new Error(`${source}: ${message}`);
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

async function defaultDigest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function ffprobe(args) {
  const result = spawnSync("ffprobe", ["-v", "error", ...args], {
    encoding: "utf8",
  });
  if (result.error) throw new Error(`ffprobe: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Streams, pixel format, and counted frames of one media file. */
export function probeMedia(path) {
  return ffprobe([
    "-count_frames",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,nb_read_frames:format=duration",
    "-of",
    "json",
    path,
  ]);
}

/** Decode every frame; throws on any decoder error. */
export function decodeMedia(path) {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-v", "error", "-xerror", "-i", path, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  if (result.error) throw new Error(`ffmpeg: ${result.error.message}`);
  if (result.status !== 0 || result.stderr.trim())
    throw new Error(`${path} does not decode cleanly: ${result.stderr}`);
}

const expectedDimensions = {
  gif: {
    width: TUI_GIF_WIDTH,
    height: Math.round((tuiCanvas.height * TUI_GIF_WIDTH) / tuiCanvas.width),
  },
  mp4: { width: tuiCanvas.width, height: tuiCanvas.height },
  webm: { width: tuiCanvas.width, height: tuiCanvas.height },
  poster: { width: tuiCanvas.width, height: tuiCanvas.height },
};

function validateShape(metadata) {
  requireCondition(
    metadata && typeof metadata === "object",
    "metadata",
    "is required",
  );
  requireCondition(
    metadata.schema === TUI_DEMO_SCHEMA,
    "metadata.schema",
    `must be ${TUI_DEMO_SCHEMA}`,
  );
  requireCondition(
    metadata.mode === "tui-demo",
    "metadata.mode",
    "must be tui-demo",
  );
  requireCondition(
    /^[0-9a-f]{40}$/.test(metadata.sourceCommit ?? ""),
    "metadata.sourceCommit",
    "must be a full commit hash",
  );
  requireCondition(
    typeof metadata.versionLabel === "string" &&
      metadata.versionLabel.includes(metadata.sourceCommit.slice(0, 7)),
    "metadata.versionLabel",
    "must name the source commit",
  );
  for (const field of ["release_binary_sha256", "source_sha256"])
    requireCondition(
      /^[0-9a-f]{64}$/.test(metadata[field] ?? ""),
      `metadata.${field}`,
      "must be a sha256",
    );
  requireCondition(
    JSON.stringify(metadata.storyboard) === JSON.stringify(tuiStoryboard),
    "metadata.storyboard",
    "does not match scripts/tui-demo-config.mjs",
  );
  // Every scene's checkpoint matched the real terminal, in storyboard order.
  const checkpoints = metadata.recorder?.checkpoints ?? {};
  let previous = -1;
  for (const cue of tuiStoryboard) {
    const index = checkpoints[cue.scene];
    requireCondition(
      Number.isInteger(index) && index >= previous,
      `metadata.recorder.checkpoints.${cue.scene}`,
      "must record where the scene was seen in the real terminal",
    );
    previous = index;
  }
  const grid = metadata.recorder?.grid;
  requireCondition(
    Number.isInteger(grid?.columns) && Number.isInteger(grid?.rows),
    "metadata.recorder.grid",
    "must record the measured terminal grid",
  );
}

async function validateOutputs(root, metadata, io) {
  for (const [format, spec] of Object.entries(tuiOutputs)) {
    const source = `metadata.outputs.${format}`;
    const record = metadata.outputs?.[format];
    requireCondition(record, source, "is required");
    requireCondition(record.path === spec.path, source, `must be ${spec.path}`);
    const path = resolve(root, spec.path);
    const size = fileSize(path);
    requireCondition(size > 0, source, `${spec.path} is absent or empty`);
    requireCondition(record.bytes === size, `${source}.bytes`, "size mismatch");
    requireCondition(
      record.sha256 === (await io.digest(path)),
      `${source}.sha256`,
      `${spec.path} does not match its recorded hash`,
    );
  }

  const label = metadata.versionLabel;
  requireCondition(
    readFileSync(resolve(root, tuiOutputs.vtt.path), "utf8") === tuiWebVtt(),
    "metadata.outputs.vtt",
    "captions do not match the storyboard",
  );
  requireCondition(
    readFileSync(resolve(root, tuiOutputs.txt.path), "utf8") ===
      tuiTranscript(label),
    "metadata.outputs.txt",
    "transcript does not match the storyboard and version label",
  );

  const budgeted = metadata.outputs.gif.bytes + metadata.outputs.poster.bytes;
  requireCondition(
    budgeted <= TUI_MEDIA_BUDGET_BYTES,
    "metadata.outputs.gif",
    `GIF and poster total ${budgeted} bytes, over the ${TUI_MEDIA_BUDGET_BYTES}-byte budget`,
  );

  // v1-compatible summary consumed by the product demo capture.
  requireCondition(
    metadata.output?.path === tuiOutputs.gif.path &&
      metadata.output?.sha256 === metadata.outputs.gif.sha256 &&
      metadata.output?.poster === tuiOutputs.poster.path &&
      metadata.output?.poster_sha256 === metadata.outputs.poster.sha256,
    "metadata.output",
    "must summarise the GIF and poster outputs",
  );
}

function validateProbes(root, io) {
  for (const format of ["gif", "mp4", "webm", "poster"]) {
    const spec = tuiOutputs[format];
    const source = `${spec.path}`;
    const probed = io.probe(resolve(root, spec.path));
    const streams = probed.streams ?? [];
    requireCondition(
      !streams.some((stream) => stream.codec_type === "audio"),
      source,
      "must not contain audio",
    );
    const video = streams.find((stream) => stream.codec_type === "video");
    requireCondition(video, source, "has no video stream");
    const codec = format === "poster" ? "png" : spec.codec;
    requireCondition(
      video.codec_name === codec,
      source,
      `codec ${video.codec_name} is not ${codec}`,
    );
    const expected = expectedDimensions[format];
    requireCondition(
      video.width === expected.width && video.height === expected.height,
      source,
      `is ${video.width}×${video.height}, expected ${expected.width}×${expected.height}`,
    );
    if (format === "poster") continue;
    const duration = Number(probed.format?.duration);
    requireCondition(
      Math.abs(duration - TUI_DEMO_DURATION_SECONDS) <=
        TUI_DURATION_TOLERANCE_SECONDS,
      source,
      `duration ${duration}s is outside ${TUI_DEMO_DURATION_SECONDS}s ± ${TUI_DURATION_TOLERANCE_SECONDS}s`,
    );
    if (format === "mp4")
      requireCondition(
        video.pix_fmt === "yuv420p",
        source,
        `pixel format ${video.pix_fmt} is not yuv420p`,
      );
    if (format !== "gif" && video.nb_read_frames !== undefined)
      requireCondition(
        Number(video.nb_read_frames) ===
          TUI_DEMO_DURATION_SECONDS * TUI_FRAME_RATE,
        source,
        `has ${video.nb_read_frames} frames, expected ${TUI_DEMO_DURATION_SECONDS * TUI_FRAME_RATE}`,
      );
  }
}

/**
 * Validate one TUI demo package rooted at `root` (the repository or a staging
 * directory with the same `docs/assets` layout).
 *
 * @param {string} root
 * @param {object} metadata parsed provenance
 * @param {{ digest?: Function, probe?: Function | null, decode?: Function | null }} [injected]
 *   `probe`/`decode` default to ffprobe/ffmpeg; pass `null` to skip them where
 *   ffmpeg is unavailable (hashes, captions, and budget are still checked).
 */
export async function validateTuiMedia(root, metadata, injected = {}) {
  const io = {
    digest: injected.digest ?? defaultDigest,
    probe: injected.probe === undefined ? probeMedia : injected.probe,
    decode: injected.decode === undefined ? decodeMedia : injected.decode,
  };
  validateShape(metadata);
  await validateOutputs(root, metadata, io);
  if (io.probe) validateProbes(root, io);
  if (io.decode)
    for (const format of ["gif", "mp4", "webm"])
      io.decode(resolve(root, tuiOutputs[format].path));
  return metadata;
}

/** Whether ffprobe and ffmpeg are runnable here. */
export function ffmpegAvailable() {
  return ["ffprobe", "ffmpeg"].every(
    (tool) => !spawnSync(tool, ["-version"], { stdio: "ignore" }).error,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    const root = resolve(process.argv[2] ?? ".");
    const metadata = JSON.parse(
      readFileSync(resolve(root, TUI_DEMO_CAPTURE_PATH), "utf8"),
    );
    await validateTuiMedia(root, metadata);
    process.stdout.write(`TUI media is valid: ${TUI_DEMO_CAPTURE_PATH}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
