// Validate the checked-in product demo capture (`scripts/product-demo.capture.json`)
// against the authoritative storyboard and the media files it claims.
//
// `validateProductMedia` is the import-safe entry point: it takes injected
// `probe`, `digest`, and `commitExists` functions so tests can run without
// ffmpeg, git, or real media. The CLI at the bottom wires the real ffprobe,
// SHA-256, and git checks and reads the capture file from disk.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_DEMO_CAPTURE_PATH,
  PRODUCT_DEMO_PROVENANCE,
  PRODUCT_DEMO_SCHEMA,
  TUI_DEMO_INPUT,
  cuesFor,
  deliverables,
  durationToleranceSeconds,
  frameRate,
  outputDimensions,
  readSourceVersion,
  sourceDimensions,
  storyboard,
  transcript,
  validateStoryboard,
  versionLabel,
  webVtt,
} from "./product-demo-config.mjs";

function requireCondition(condition, source, message) {
  if (!condition) throw new Error(`${source}: ${message}`);
}

function defaultProbe(path) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,width,height:format=duration",
      "-of",
      "json",
      path,
    ],
    { encoding: "utf8" },
  );
  if (result.error)
    throw new Error(`ffprobe could not start: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `ffprobe failed for ${path}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return JSON.parse(result.stdout);
}

function defaultDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function defaultCommitExists(commit) {
  return (
    spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      encoding: "utf8",
    }).status === 0
  );
}

function fileSize(path) {
  try {
    const info = statSync(path);
    return info.isFile() ? info.size : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readJson(path, source) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`${source}: ${path} is unavailable`);
    throw new Error(`${source}: ${path} is not valid JSON (${error.message})`);
  }
}

function readText(path, source) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`${source}: ${path} is unavailable`);
    throw error;
  }
}

async function validateAsset(root, source, recorded, spec, deliverable, io) {
  requireCondition(
    recorded && typeof recorded === "object",
    source,
    "is missing",
  );
  requireCondition(
    recorded.path === spec.path,
    `${source}.path`,
    `must be ${spec.path}`,
  );
  const path = resolve(root, spec.path);
  const size = fileSize(path);
  requireCondition(
    size !== null && size > 0,
    source,
    `${spec.path} is absent or empty`,
  );
  requireCondition(
    recorded.bytes === size,
    `${source}.bytes`,
    "does not match the file size",
  );
  requireCondition(
    typeof recorded.sha256 === "string" &&
      recorded.sha256 === (await io.digest(path)),
    `${source}.sha256`,
    "does not match the file hash",
  );

  if (spec.text) {
    requireCondition(
      recorded.codec === spec.codec,
      `${source}.codec`,
      `must be ${spec.codec}`,
    );
    requireCondition(
      recorded.durationSeconds === null,
      `${source}.durationSeconds`,
      "must be null for a text asset",
    );
    return;
  }

  const details = await io.probe(path);
  const streams = Array.isArray(details?.streams) ? details.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  requireCondition(video, source, "has no video stream");
  requireCondition(
    video.codec_name === spec.codec,
    `${source}.codec`,
    `expected ${spec.codec}, got ${video.codec_name}`,
  );
  requireCondition(
    video.width === outputDimensions.width &&
      video.height === outputDimensions.height,
    source,
    `dimensions must be ${outputDimensions.width}x${outputDimensions.height}`,
  );
  requireCondition(
    !streams.some((stream) => stream.codec_type === "audio"),
    source,
    "must not contain audio",
  );

  if (spec.duration) {
    const probed = Number(details?.format?.duration);
    requireCondition(
      Number.isFinite(probed),
      source,
      "has no readable duration",
    );
    requireCondition(
      Math.abs(probed - deliverable.durationSeconds) <=
        durationToleranceSeconds,
      `${source}.duration`,
      `duration ${probed}s is outside ${deliverable.durationSeconds}s ± ${durationToleranceSeconds}s`,
    );
    requireCondition(
      Number.isFinite(recorded.durationSeconds) &&
        Math.abs(recorded.durationSeconds - probed) <= durationToleranceSeconds,
      `${source}.durationSeconds`,
      "does not match the probed duration",
    );
  } else {
    requireCondition(
      recorded.durationSeconds === null,
      `${source}.durationSeconds`,
      "must be null for a still asset",
    );
  }
}

async function validateDeliverable(root, metadata, deliverable, io) {
  const source = `metadata.outputs.${deliverable.id}`;
  const recorded = metadata.outputs?.[deliverable.id];
  requireCondition(
    recorded && typeof recorded === "object",
    source,
    "is missing",
  );
  requireCondition(
    recorded.kind === deliverable.kind,
    `${source}.kind`,
    `must be ${deliverable.kind}`,
  );
  requireCondition(
    recorded.durationSeconds === deliverable.durationSeconds,
    `${source}.durationSeconds`,
    `must be ${deliverable.durationSeconds}`,
  );

  const expectedCues = cuesFor(deliverable, metadata.storyboard);
  requireCondition(
    Array.isArray(recorded.cues) &&
      recorded.cues.length === expectedCues.length,
    `${source}.cues`,
    `must contain ${expectedCues.length} cues`,
  );
  for (const [index, cue] of recorded.cues.entries()) {
    const expected = expectedCues[index];
    requireCondition(
      cue.text === expected.text &&
        cue.start === expected.start &&
        cue.end === expected.end &&
        cue.scene === expected.scene,
      `${source}.cues[${index}]`,
      "timing or scene does not match the storyboard",
    );
    requireCondition(
      cue.end <= deliverable.durationSeconds + durationToleranceSeconds,
      `${source}.cues[${index}]`,
      "cue extends past the deliverable duration",
    );
    requireCondition(
      typeof cue.text === "string" && cue.text.trim() !== "",
      `${source}.cues[${index}]`,
      "caption text is required",
    );
  }

  requireCondition(
    recorded.assets && typeof recorded.assets === "object",
    `${source}.assets`,
    "is required",
  );
  requireCondition(
    recorded.posterSeconds === deliverable.posterSeconds,
    `${source}.posterSeconds`,
    "must match the configured poster checkpoint",
  );
  requireCondition(
    Object.keys(recorded.assets).sort().join(",") ===
      Object.keys(deliverable.outputs).sort().join(","),
    `${source}.assets`,
    "must contain exactly the configured formats",
  );
  for (const [format, spec] of Object.entries(deliverable.outputs))
    await validateAsset(
      root,
      `${source}.assets.${format}`,
      recorded.assets[format],
      spec,
      deliverable,
      io,
    );

  const expectedVtt = webVtt(deliverable, metadata.storyboard);
  requireCondition(
    readText(
      resolve(root, deliverable.outputs.vtt.path),
      `${source}.assets.vtt`,
    ) === expectedVtt,
    `${source}.assets.vtt`,
    "does not match the rebased cues",
  );
  const expectedTranscript = transcript(
    deliverable,
    metadata.versionLabel,
    metadata.storyboard,
  );
  requireCondition(
    readText(
      resolve(root, deliverable.outputs.txt.path),
      `${source}.assets.txt`,
    ) === expectedTranscript,
    `${source}.assets.txt`,
    "transcript does not match the storyboard and version label",
  );
}

async function validateInputs(root, metadata, io) {
  const source = "metadata.inputs.tuiDemo";
  const input = metadata.inputs?.tuiDemo;
  requireCondition(input && typeof input === "object", source, "is required");
  requireCondition(
    input.provenance === "prerecorded demo footage",
    source,
    "must identify prerecorded footage",
  );
  requireCondition(
    input.path === TUI_DEMO_INPUT.path,
    `${source}.path`,
    `must be ${TUI_DEMO_INPUT.path}`,
  );
  requireCondition(
    input.capturePath === TUI_DEMO_INPUT.capturePath,
    `${source}.capturePath`,
    `must be ${TUI_DEMO_INPUT.capturePath}`,
  );

  const gifPath = resolve(root, input.path);
  const gifSize = fileSize(gifPath);
  requireCondition(
    gifSize !== null && gifSize > 0,
    source,
    `${input.path} is absent or empty`,
  );
  requireCondition(
    input.bytes === gifSize,
    `${source}.bytes`,
    "does not match the TUI gif size",
  );
  requireCondition(
    input.sha256 === (await io.digest(gifPath)),
    `${source}.sha256`,
    "does not match the TUI gif hash",
  );

  const capturePath = resolve(root, input.capturePath);
  const captureSize = fileSize(capturePath);
  requireCondition(
    captureSize !== null && captureSize > 0,
    source,
    `${input.capturePath} is absent or empty`,
  );
  requireCondition(
    input.captureSha256 === (await io.digest(capturePath)),
    `${source}.captureSha256`,
    "does not match the TUI capture hash",
  );

  const capture = readJson(capturePath, `${source}.capture`);
  requireCondition(
    JSON.stringify(input.originalCapture) === JSON.stringify(capture),
    source,
    "must preserve the original capture provenance",
  );
  requireCondition(
    capture.schema === "demo-capture-v1",
    `${source}.capture.schema`,
    "must be demo-capture-v1",
  );
  requireCondition(
    capture.output?.path === input.path,
    `${source}.capture.output.path`,
    "must reference the TUI gif",
  );
  requireCondition(
    capture.output?.sha256 === input.sha256,
    `${source}.capture.output.sha256`,
    "must match the recorded TUI gif hash",
  );
  requireCondition(
    capture.source_sha256 === input.sourceSha256,
    `${source}.sourceSha256`,
    "must preserve the original capture source hash",
  );
  requireCondition(
    capture.release_binary_sha256 === input.releaseBinarySha256,
    `${source}.releaseBinarySha256`,
    "must preserve the original capture binary hash",
  );
  requireCondition(
    capture.output?.poster_sha256 === input.posterSha256,
    `${source}.posterSha256`,
    "must preserve the original poster hash",
  );
}

function validateMetadataShape(metadata, sourceVersion) {
  requireCondition(
    metadata && typeof metadata === "object",
    "metadata",
    "expected a capture object",
  );
  requireCondition(
    metadata.schema === PRODUCT_DEMO_SCHEMA,
    "metadata.schema",
    `must be ${PRODUCT_DEMO_SCHEMA}`,
  );
  requireCondition(
    typeof metadata.capturedAt === "string" &&
      Number.isFinite(Date.parse(metadata.capturedAt)),
    "metadata.capturedAt",
    "must be an ISO timestamp",
  );
  requireCondition(
    typeof metadata.sourceCommit === "string" &&
      /^[0-9a-f]{40}$/.test(metadata.sourceCommit),
    "metadata.sourceCommit",
    "must be a full commit hash",
  );
  requireCondition(
    metadata.provenance === PRODUCT_DEMO_PROVENANCE,
    "metadata.provenance",
    "must preserve the deterministic provenance marker",
  );
  requireCondition(
    metadata.frameRate === frameRate,
    "metadata.frameRate",
    `must be ${frameRate}`,
  );
  requireCondition(
    JSON.stringify(metadata.sourceDimensions) ===
      JSON.stringify(sourceDimensions),
    "metadata.sourceDimensions",
    `must be ${sourceDimensions.width}x${sourceDimensions.height}`,
  );
  requireCondition(
    JSON.stringify(metadata.outputDimensions) ===
      JSON.stringify(outputDimensions),
    "metadata.outputDimensions",
    `must be ${outputDimensions.width}x${outputDimensions.height}`,
  );
  requireCondition(
    typeof metadata.version === "string" && metadata.version.trim() !== "",
    "metadata.version",
    "is required",
  );
  requireCondition(
    metadata.version === sourceVersion,
    "metadata.version",
    `must match server/Cargo.toml (${sourceVersion})`,
  );
  requireCondition(
    typeof metadata.versionLabel === "string" && metadata.versionLabel !== "",
    "metadata.versionLabel",
    "is required",
  );
  requireCondition(
    metadata.versionLabel ===
      versionLabel(metadata.version, metadata.sourceCommit),
    "metadata.versionLabel",
    "must match the version and source commit",
  );
}

function validateTimeline(metadata) {
  const rendered = validateStoryboard(metadata.storyboard);
  rendered.forEach((cue, index) => {
    const approved = storyboard[index];
    requireCondition(
      cue.start === approved.start &&
        cue.end === approved.end &&
        cue.scene === approved.scene,
      `metadata.storyboard[${index}]`,
      "must match the approved timeline",
    );
    const expected =
      cue.scene === "installation" ? metadata.versionLabel : approved.caption;
    requireCondition(
      cue.caption === expected,
      `metadata.storyboard[${index}].caption`,
      "does not match the approved caption",
    );
  });
}

/**
 * Validate one product demo capture and every file it references.
 *
 * @param {string} root repository root
 * @param {object} metadata parsed `scripts/product-demo.capture.json`
 * @param {{ probe?: Function, digest?: Function, commitExists?: Function }} [injected]
 * @returns {Promise<object>} the validated metadata
 */
export async function validateProductMedia(root, metadata, injected = {}) {
  const io = {
    probe: injected.probe ?? defaultProbe,
    digest: injected.digest ?? defaultDigest,
    commitExists: injected.commitExists ?? defaultCommitExists,
  };
  const sourceVersion = readSourceVersion(root);
  validateMetadataShape(metadata, sourceVersion);
  requireCondition(
    await io.commitExists(metadata.sourceCommit),
    "metadata.sourceCommit",
    `commit ${metadata.sourceCommit} is unavailable`,
  );
  validateTimeline(metadata);

  requireCondition(
    metadata.outputs && typeof metadata.outputs === "object",
    "metadata.outputs",
    "is required",
  );
  for (const deliverable of deliverables)
    await validateDeliverable(root, metadata, deliverable, io);
  await validateInputs(root, metadata, io);
  return metadata;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    const root = resolve(process.argv[2] ?? ".");
    const capturePath = resolve(root, PRODUCT_DEMO_CAPTURE_PATH);
    const metadata = readJson(capturePath, "product media capture");
    await validateProductMedia(root, metadata);
    process.stdout.write(
      `product media is valid: ${PRODUCT_DEMO_CAPTURE_PATH}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
