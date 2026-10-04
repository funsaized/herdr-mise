// Record the TUI demo headlessly: VHS drives the release binary in demo mode
// inside a virtual terminal and exports raw frames; Playwright renders the
// window frame and captions; ffmpeg composes and encodes the MP4, WebM, GIF,
// and poster. Nothing touches the operator's terminal, display, or windows.
//
// Like the other media captures it refuses a dirty checkout, records the
// source commit, validates the whole staged package, and only then renames
// files into place (provenance last). A failed run keeps its staging
// directory, tape, and logs for diagnosis.
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCaptureTools,
  createStaging,
  verifyCommittedSource,
} from "./capture-media.mjs";
import { validateTuiMedia } from "./check-tui-media.mjs";
import { readSourceVersion, versionLabel } from "./product-demo-config.mjs";
import {
  TUI_DEMO_CAPTURE_PATH,
  TUI_DEMO_DURATION_SECONDS,
  TUI_DEMO_PROVENANCE,
  TUI_DEMO_SCHEMA,
  TUI_DEMO_TITLE,
  TUI_FRAME_RATE,
  TUI_GIF_FRAME_RATE,
  TUI_GIF_WIDTH,
  TUI_MEDIA_BUDGET_BYTES,
  TUI_MIN_FRAME_RATIO,
  TUI_POSTER_SECONDS,
  keyLabel,
  tuiCanvas,
  tuiDemoEnvironment,
  tuiOutputs,
  tuiStoryboard,
  tuiTape,
  tuiTerminal,
  tuiTranscript,
  tuiWebVtt,
  validateTuiStoryboard,
  verifyTuiCheckpoints,
} from "./tui-demo-config.mjs";

export const USAGE = "Usage: node scripts/capture-tui-media.mjs [--help]";

const prerequisites = [
  ["vhs", ["--version"], "brew install vhs"],
  ["ffmpeg", ["-version"], "brew install ffmpeg"],
  ["ffprobe", ["-version"], "brew install ffmpeg"],
  ["gifsicle", ["--version"], "brew install gifsicle"],
  ["cargo", ["--version"], "install Rust from https://rustup.rs"],
];

const fontDirectories = [
  "/System/Library/Fonts",
  "/Library/Fonts",
  join(homedir(), "Library/Fonts"),
  "/usr/share/fonts",
  join(homedir(), ".local/share/fonts"),
];

/** Whether a font file for `family` is installed in a standard directory. */
export function fontInstalled(family, directories = fontDirectories) {
  const needle = family.toLowerCase().replace(/\s+/g, "");
  const search = (directory, depth) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) =>
      entry.isDirectory()
        ? depth > 0 && search(join(directory, entry.name), depth - 1)
        : entry.name
            .toLowerCase()
            .replace(/[\s_-]+/g, "")
            .startsWith(needle),
    );
  };
  return directories.some((directory) => search(directory, 2));
}

/**
 * Check every external prerequisite before any work starts, with an
 * actionable message for the first that is missing.
 */
export function preflight(tools, { hasFont = fontInstalled } = {}) {
  const versions = {};
  for (const [command, args, install] of prerequisites) {
    try {
      versions[command] = tools.run(command, args).split("\n")[0];
    } catch {
      throw new Error(`${command} is required (${install})`);
    }
  }
  const encoders = tools.run("ffmpeg", ["-hide_banner", "-encoders"]);
  for (const encoder of ["libx264", "libvpx-vp9"])
    if (!encoders.includes(encoder))
      throw new Error(`ffmpeg lacks the ${encoder} encoder`);
  const filters = tools.run("ffmpeg", ["-hide_banner", "-filters"]);
  for (const filter of ["overlay", "palettegen", "paletteuse"])
    if (!new RegExp(`\\s${filter}\\s`).test(filters))
      throw new Error(`ffmpeg lacks the ${filter} filter`);
  if (!hasFont(tuiTerminal.fontFamily))
    throw new Error(
      `the ${tuiTerminal.fontFamily} font is required; VHS would silently substitute a different face`,
    );
  return versions;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Raw VHS frames, verified contiguous. VHS writes a text layer and a cursor
 * layer per frame; the TUI hides the cursor, so only the text layer is used.
 */
export function rawFrames(frameDir) {
  const names = existsSync(frameDir) ? readdirSync(frameDir) : [];
  const indices = names
    .map((name) => /^frame-text-(\d{5})\.png$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  if (indices.length === 0)
    throw new Error(
      `VHS produced no frames in ${frameDir}; see vhs.log (it can report success without writing output)`,
    );
  indices.forEach((value, index) => {
    if (value !== index + 1)
      throw new Error(`VHS frame sequence is incomplete at frame ${index + 1}`);
  });
  const expected = TUI_DEMO_DURATION_SECONDS * TUI_FRAME_RATE;
  if (indices.length < expected * TUI_MIN_FRAME_RATIO)
    throw new Error(
      `VHS captured ${indices.length} of ${expected} frames; close other heavy apps and retry`,
    );
  return indices.length;
}

/** Parse `stty size` output and require the full-scene grid. */
export function parseGrid(text) {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(text ?? "");
  if (!match) throw new Error(`could not read the terminal grid: ${text}`);
  const grid = { rows: Number(match[1]), columns: Number(match[2]) };
  if (grid.columns < tuiTerminal.minColumns || grid.rows < tuiTerminal.minRows)
    throw new Error(
      `terminal grid ${grid.columns}×${grid.rows} is below ${tuiTerminal.minColumns}×${tuiTerminal.minRows}; the TUI would fall back to its compact table`,
    );
  return grid;
}

const escapeHtml = (text) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );

/** One transparent full-canvas overlay: window chrome plus a scene caption. */
export function overlayHtml(cue, index, storyboard = tuiStoryboard) {
  const { width, height, margin, titleBar, captionBar } = tuiCanvas;
  const keys = cue.keys
    .map((key) => `<kbd>${escapeHtml(keyLabel(key))}</kbd>`)
    .join("");
  const dots = storyboard
    .map((_, dot) => `<i class="${dot === index ? "on" : ""}"></i>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}
.canvas{position:relative;width:${width}px;height:${height}px;font-family:-apple-system,"SF Pro Text","Helvetica Neue",Arial,sans-serif;overflow:hidden}
.mask{position:absolute;inset:0;border-style:solid;border-color:#0b0d10;border-width:${margin}px ${margin}px ${captionBar}px;box-sizing:border-box}
.window{position:absolute;left:${margin - 1}px;top:${margin - 1}px;width:${tuiTerminal.width}px;height:${titleBar + tuiTerminal.height}px;border:1px solid #2c3138;border-radius:12px;box-shadow:0 0 0 ${margin}px #0b0d10}
.title{position:absolute;left:${margin}px;top:${margin}px;width:${tuiTerminal.width}px;height:${titleBar}px;background:#1b1e23;border-radius:11px 11px 0 0;border-bottom:1px solid #2c3138;box-sizing:border-box;display:flex;align-items:center;justify-content:center;color:#9aa4b2;font:500 13px ui-monospace,Menlo,monospace}
.lights{position:absolute;left:14px;top:12px;display:flex;gap:8px}.lights i{width:12px;height:12px;border-radius:50%;display:block}
.badge{position:absolute;right:14px;top:8px;padding:3px 8px;border-radius:6px;background:#3a2a10;color:#f0b44c;font:600 11px -apple-system,Arial,sans-serif;letter-spacing:.06em}
.caption{position:absolute;left:${margin}px;right:${margin}px;bottom:0;height:${captionBar}px;display:flex;align-items:center;gap:12px;color:#e8eaed;font-size:19px;font-weight:500}
kbd{display:inline-block;min-width:16px;padding:4px 9px;border-radius:6px;background:#262b33;border:1px solid #4a525e;border-bottom-width:3px;color:#fff;font:600 16px ui-monospace,Menlo,monospace;text-align:center}
.keys{display:flex;gap:6px}.text{flex:1}
.dots{display:flex;gap:6px}.dots i{width:7px;height:7px;border-radius:50%;background:#3a414b;display:block}.dots i.on{background:#f0b44c}
</style></head><body><div class="canvas">
<div class="mask"></div><div class="window"></div>
<div class="title"><div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>${escapeHtml(TUI_DEMO_TITLE)}<span class="badge">DEMO SERVICE</span></div>
<div class="caption">${keys ? `<span class="keys">${keys}</span>` : ""}<span class="text">${escapeHtml(cue.caption)}</span><span class="dots">${dots}</span></div>
</div></body></html>`;
}

async function renderOverlays(directory) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: tuiCanvas.width, height: tuiCanvas.height },
      deviceScaleFactor: 1,
    });
    const paths = [];
    for (const [index, cue] of tuiStoryboard.entries()) {
      await page.setContent(overlayHtml(cue, index));
      await page.evaluate(() => document.fonts.ready);
      const path = join(directory, `overlay-${index}.png`);
      await page.screenshot({ path, omitBackground: true });
      paths.push(path);
    }
    return paths;
  } finally {
    await browser.close();
  }
}

/** ffmpeg filter graph: retimed terminal frames inside the framed window. */
export function compositionFilter(rawFrameCount) {
  const { width, height, terminalX, terminalY } = tuiCanvas;
  const parts = [
    `color=c=${tuiTerminal.background}:s=${width}x${height}:r=${TUI_FRAME_RATE}:d=${TUI_DEMO_DURATION_SECONDS}[bg]`,
    // Spread the captured frames evenly over the storyboard duration (VHS
    // drops frames under load), then resample to the output frame rate.
    `[0:v]setpts=N/(${rawFrameCount}/${TUI_DEMO_DURATION_SECONDS})/TB,fps=${TUI_FRAME_RATE}[term]`,
    `[bg][term]overlay=${terminalX}:${terminalY}:eof_action=repeat[v0]`,
  ];
  tuiStoryboard.forEach((cue, index) => {
    parts.push(
      `[v${index}][${index + 1}:v]overlay=0:0:enable='gte(t,${cue.start})*lt(t,${cue.end})'[v${index + 1}]`,
    );
  });
  return { graph: parts.join(";"), output: `[v${tuiStoryboard.length}]` };
}

/** Build the embedded client and the locked release binary; returns its path. */
export function buildRelease(root, tools) {
  tools.run("npm", ["run", "build"]);
  tools.run("cargo", ["build", "--release", "--locked", "--bin", "herdr-mise"]);
  return join(root, "target/release/herdr-mise");
}

/**
 * Record the storyboard with VHS against `binary` into `staging`: raw frames,
 * the measured grid, and per-command terminal text. Verifies the frames, the
 * full-scene grid, and that every scene's checkpoint appears, in order, in the
 * real terminal. Leaves the tape and `vhs.log` in `staging` for diagnosis.
 */
export async function recordTui({
  tools,
  staging,
  binary,
  port,
  storyboard = tuiStoryboard,
}) {
  const frameDir = join(staging, "frames");
  const gridPath = join(staging, "grid.txt");
  const textPath = join(staging, "terminal.ascii");
  const tapePath = join(staging, "tui-demo.tape");
  await writeFile(
    tapePath,
    tuiTape(
      {
        frameDir,
        textPath,
        gridPath,
        binary,
        socketPath: join(staging, "no-herdr.sock"),
        port,
      },
      storyboard,
    ),
  );
  try {
    await writeFile(join(staging, "vhs.log"), tools.run("vhs", [tapePath]));
  } catch (error) {
    await writeFile(join(staging, "vhs.log"), error.message);
    throw error;
  }
  const grid = parseGrid(
    existsSync(gridPath) ? await readFile(gridPath, "utf8") : "",
  );
  const frameCount = rawFrames(frameDir);
  const checkpoints = verifyTuiCheckpoints(
    existsSync(textPath) ? await readFile(textPath, "utf8") : "",
    storyboard,
  );
  return { frameDir, tapePath, grid, frameCount, checkpoints };
}

function defaultDependencies(root) {
  return {
    tools: createCaptureTools(root),
    verifySource: verifyCommittedSource,
    preflight,
    build: buildRelease,
    renderOverlays,
    validate: validateTuiMedia,
    freePort,
  };
}

/**
 * Capture and publish the TUI demo. `dependencies` exists for tests; the
 * defaults run the real tools.
 */
export async function captureTui(root, dependencies = {}) {
  const deps = { ...defaultDependencies(root), ...dependencies };
  const { tools } = deps;
  // Guard first: nothing is created or launched for a dirty checkout.
  const sourceCommit = deps.verifySource(root);
  validateTuiStoryboard();
  const versions = deps.preflight(tools);
  const version = readSourceVersion(root);
  const label = versionLabel(version, sourceCommit);
  const binary = deps.build(root, tools);

  const staging = await createStaging(root, "tui");
  let published = false;
  try {
    const { frameDir, tapePath, grid, frameCount, checkpoints } =
      await recordTui({
        tools,
        staging,
        binary,
        port: await deps.freePort(),
      });

    const overlays = await deps.renderOverlays(staging);
    const composed = join(staging, "composed");
    await mkdir(composed);
    const { graph, output } = compositionFilter(frameCount);
    const totalFrames = TUI_DEMO_DURATION_SECONDS * TUI_FRAME_RATE;
    tools.encode([
      "-framerate",
      String(TUI_FRAME_RATE),
      "-i",
      join(frameDir, "frame-text-%05d.png"),
      ...overlays.flatMap((path) => ["-loop", "1", "-i", path]),
      "-filter_complex",
      graph,
      "-map",
      output,
      "-frames:v",
      String(totalFrames),
      join(composed, "frame-%04d.png"),
    ]);

    const out = (spec) => join(staging, spec.path);
    await mkdir(dirname(out(tuiOutputs.gif)), { recursive: true });
    const input = [
      "-framerate",
      String(TUI_FRAME_RATE),
      "-i",
      join(composed, "frame-%04d.png"),
    ];
    const limit = ["-frames:v", String(totalFrames)];
    // GIF: one palette from every frame, then lossless gifsicle optimisation.
    // The palette input loops because ffmpeg 9 hits a framesync error when it
    // ends before the frame input.
    const gifScale = `fps=${TUI_GIF_FRAME_RATE},scale=${TUI_GIF_WIDTH}:-2:flags=lanczos`;
    const palette = join(staging, "palette.png");
    const rawGif = join(staging, "raw.gif");
    tools.encode([
      ...input,
      "-vf",
      `${gifScale},palettegen=max_colors=128:stats_mode=full`,
      "-update",
      "1",
      palette,
    ]);
    tools.encode([
      ...input,
      "-loop",
      "1",
      "-i",
      palette,
      "-frames:v",
      String(TUI_DEMO_DURATION_SECONDS * TUI_GIF_FRAME_RATE),
      "-lavfi",
      `${gifScale}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`,
      "-loop",
      "0",
      rawGif,
    ]);
    tools.run("gifsicle", ["-O3", rawGif, "-o", out(tuiOutputs.gif)]);
    tools.encode([
      ...input,
      ...limit,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "20",
      "-tune",
      "animation",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      out(tuiOutputs.mp4),
    ]);
    tools.encode([
      ...input,
      ...limit,
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      "0",
      "-crf",
      "34",
      "-row-mt",
      "1",
      out(tuiOutputs.webm),
    ]);
    tools.encode([
      "-i",
      join(
        composed,
        `frame-${String(TUI_POSTER_SECONDS * TUI_FRAME_RATE + 1).padStart(4, "0")}.png`,
      ),
      "-frames:v",
      "1",
      "-compression_level",
      "9",
      out(tuiOutputs.poster),
    ]);
    await writeFile(out(tuiOutputs.vtt), tuiWebVtt());
    await writeFile(out(tuiOutputs.txt), tuiTranscript(label));

    const outputs = {};
    for (const [format, spec] of Object.entries(tuiOutputs))
      outputs[format] = {
        path: spec.path,
        bytes: (await stat(out(spec))).size,
        sha256: await tools.digest(out(spec)),
      };
    const configPath = join(root, "scripts/tui-demo-config.mjs");
    const metadata = {
      schema: TUI_DEMO_SCHEMA,
      mode: "tui-demo",
      automated: true,
      provenance: TUI_DEMO_PROVENANCE,
      captured_at: new Date().toISOString(),
      sourceCommit,
      version,
      versionLabel: label,
      release_binary_sha256: await tools.digest(binary),
      // The generated tape is the recording's source.
      source_sha256: await tools.digest(tapePath),
      config_sha256: await tools.digest(configPath),
      recorder: {
        tools: versions,
        font: tuiTerminal.fontFamily,
        fontSize: tuiTerminal.fontSize,
        terminal: {
          width: tuiTerminal.width,
          height: tuiTerminal.height,
          padding: tuiTerminal.padding,
        },
        grid,
        checkpoints,
        rawFrames: frameCount,
        expectedFrames: totalFrames,
        environment: tuiDemoEnvironment,
      },
      frameRate: TUI_FRAME_RATE,
      gifFrameRate: TUI_GIF_FRAME_RATE,
      dimensions: { width: tuiCanvas.width, height: tuiCanvas.height },
      durationSeconds: TUI_DEMO_DURATION_SECONDS,
      storyboard: tuiStoryboard,
      // v1-compatible summary consumed by the product demo capture.
      output: {
        path: tuiOutputs.gif.path,
        sha256: outputs.gif.sha256,
        bytes: outputs.gif.bytes,
        poster: tuiOutputs.poster.path,
        poster_sha256: outputs.poster.sha256,
        total_media_bytes: outputs.gif.bytes + outputs.poster.bytes,
        media_budget_bytes: TUI_MEDIA_BUDGET_BYTES,
        scheduled_views: tuiStoryboard.map((cue) => cue.scene),
      },
      outputs,
    };
    await deps.validate(staging, metadata);

    if (deps.verifySource(root) !== sourceCommit)
      throw new Error("source commit changed during capture");
    for (const spec of Object.values(tuiOutputs))
      await rename(out(spec), join(root, spec.path));
    await writeFile(
      join(root, TUI_DEMO_CAPTURE_PATH),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    published = true;
    return metadata;
  } finally {
    if (published && process.env.TUI_RETAIN_STAGING !== "1")
      await rm(staging, { recursive: true });
    else if (published) console.error(`frames retained at ${staging}`);
    else console.error(`candidate retained at ${staging}`);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
  } else if (args.length) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 64;
  } else {
    try {
      const metadata = await captureTui(resolve("."));
      process.stdout.write(
        `captured TUI media (${metadata.versionLabel}): ${Object.values(
          metadata.outputs,
        )
          .map((o) => `${o.path} ${Math.round(o.bytes / 1024)}K`)
          .join(", ")}\n`,
      );
    } catch (error) {
      process.stderr.write(`tui media capture: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
