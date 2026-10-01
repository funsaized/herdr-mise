// Capture the single README hero GIF (plus MP4/WebM fallbacks and a poster)
// from the deterministic visual playground. Like the product capture, it
// refuses to run outside a clean committed checkout and records that commit.
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCaptureTools,
  createStaging,
  startVisualServer,
  verifyCommittedSource,
} from "./capture-media.mjs";
import {
  HERO_CAPTURE_PATH,
  HERO_DURATION_SECONDS,
  HERO_POSTER_SECONDS,
  HERO_PROVENANCE,
  HERO_SCHEMA,
  heroClockCeiling,
  heroOutputs,
  heroStoryboard,
  validateHeroStoryboard,
} from "./hero-demo-config.mjs";
import {
  durationToleranceSeconds,
  frameRate,
  outputDimensions,
  readSourceVersion,
  sourceDimensions,
  versionLabel,
} from "./product-demo-config.mjs";
import {
  PRODUCT_ATTENTION_BLOCKED_MS,
  PRODUCT_SETTLE_MS,
  PRODUCT_USAGE_WARMUP_MS,
  prepareProductScene,
  setProductCaption,
} from "./product-demo-scenes.mjs";

// The README GIF trades frame rate and width for size (about 1.5 MB);
// MP4/WebM keep the full 20 fps, 960px capture.
const HERO_GIF_FPS = 10;
const HERO_GIF_WIDTH = 800;

const startingClock = {
  blocked: PRODUCT_ATTENTION_BLOCKED_MS,
  details: PRODUCT_ATTENTION_BLOCKED_MS,
  usage: PRODUCT_USAGE_WARMUP_MS,
};

export async function captureHero(root) {
  // Guard first: nothing is created or launched for a dirty checkout.
  const sourceCommit = verifyCommittedSource(root);
  validateHeroStoryboard();
  const { chromium } = await import("@playwright/test");
  const tools = createCaptureTools(root);
  const version = readSourceVersion(root);
  const label = versionLabel(version, sourceCommit);
  const rendered = heroStoryboard.map((cue) => ({
    ...cue,
    caption:
      cue.scene === "installation"
        ? `${label} · local and read-only`
        : cue.caption,
  }));
  const staging = await createStaging(root, "hero");
  const frames = join(staging, "frames");
  await mkdir(frames);
  const diagnostics = [];
  let browser;
  let visual;
  let published = false;
  try {
    const baseUrl = "http://127.0.0.1:4173";
    visual = await startVisualServer(root, baseUrl);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: sourceDimensions,
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (error) => diagnostics.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.push(message.text());
    });
    const time = Date.parse("2026-01-01T00:00:00Z");
    await page.clock.install({ time });
    await page.clock.pauseAt(time);
    for (const cue of rendered) {
      const scene = `hero-${cue.scene}`;
      await prepareProductScene(page, baseUrl, cue.scene, scene);
      await setProductCaption(page, cue.caption, scene);
      let clockMs = startingClock[cue.scene] ?? PRODUCT_SETTLE_MS;
      for (
        let frame = cue.start * frameRate;
        frame < cue.end * frameRate;
        frame++
      ) {
        await page.screenshot({
          path: join(frames, `frame-${String(frame).padStart(4, "0")}.png`),
        });
        const step = Math.min(
          1000 / frameRate,
          heroClockCeiling(cue.scene) - clockMs,
        );
        if (step > 0) {
          await page.clock.runFor(step);
          clockMs += step;
        }
      }
    }
    if (diagnostics.length)
      throw new Error(`browser diagnostics: ${diagnostics.join("\n")}`);

    const scale = `scale=${outputDimensions.width}:${outputDimensions.height}:flags=lanczos`;
    const input = [
      "-framerate",
      String(frameRate),
      "-i",
      join(frames, "frame-%04d.png"),
    ];
    const limit = ["-frames:v", String(HERO_DURATION_SECONDS * frameRate)];
    const out = (spec) => join(staging, spec.path);
    await mkdir(dirname(out(heroOutputs.gif)), { recursive: true });
    // GIF: one 256-colour palette from every frame (short scenes such as the
    // freezer keep their hues), no transparency diffing (it corrupts caption
    // overlays above the animated TUI), then lossless gifsicle optimisation.
    const gifScale = `scale=${HERO_GIF_WIDTH}:-1:flags=lanczos`;
    const palette = join(staging, "hero-palette.png");
    const rawGif = join(staging, "hero-raw.gif");
    tools.encode([
      ...input,
      ...limit,
      "-vf",
      `fps=${HERO_GIF_FPS},${gifScale},palettegen=max_colors=256:stats_mode=full`,
      "-update",
      "1",
      palette,
    ]);
    // Loop the single palette image: ffmpeg 9 hits an internal framesync
    // error when the palette stream ends before the frame input.
    tools.encode([
      ...input,
      "-loop",
      "1",
      "-i",
      palette,
      "-frames:v",
      String(HERO_DURATION_SECONDS * HERO_GIF_FPS),
      "-lavfi",
      `fps=${HERO_GIF_FPS},${gifScale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
      "-gifflags",
      "-offsetting-transdiff",
      "-loop",
      "0",
      rawGif,
    ]);
    tools.run("gifsicle", ["-O3", rawGif, "-o", out(heroOutputs.gif)]);
    tools.encode([
      ...input,
      ...limit,
      "-vf",
      scale,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      out(heroOutputs.mp4),
    ]);
    tools.encode([
      ...input,
      ...limit,
      "-vf",
      scale,
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "36",
      out(heroOutputs.webm),
    ]);
    tools.encode([
      "-i",
      join(
        frames,
        `frame-${String(HERO_POSTER_SECONDS * frameRate).padStart(4, "0")}.png`,
      ),
      "-vf",
      scale,
      "-frames:v",
      "1",
      out(heroOutputs.poster),
    ]);

    const outputs = {};
    for (const [format, spec] of Object.entries(heroOutputs)) {
      const path = out(spec);
      const probed = tools.probe(path);
      const stream = probed.streams?.find((s) => s.codec_type === "video");
      const width = format === "gif" ? HERO_GIF_WIDTH : outputDimensions.width;
      if (stream?.width !== width)
        throw new Error(`${spec.path}: unexpected width ${stream?.width}`);
      if (format !== "poster") {
        const duration = Number(probed.format?.duration);
        if (
          Math.abs(duration - HERO_DURATION_SECONDS) > durationToleranceSeconds
        )
          throw new Error(
            `${spec.path}: duration ${duration}s is outside ${HERO_DURATION_SECONDS}s ± ${durationToleranceSeconds}s`,
          );
      }
      outputs[format] = {
        path: spec.path,
        bytes: (await stat(path)).size,
        sha256: await tools.digest(path),
      };
    }
    const metadata = {
      schema: HERO_SCHEMA,
      capturedAt: new Date().toISOString(),
      sourceCommit,
      provenance: HERO_PROVENANCE,
      version,
      versionLabel: label,
      frameRate,
      sourceDimensions,
      outputDimensions,
      durationSeconds: HERO_DURATION_SECONDS,
      storyboard: rendered,
      outputs,
    };
    if (verifyCommittedSource(root) !== sourceCommit)
      throw new Error("source commit changed during capture");
    for (const spec of Object.values(heroOutputs))
      await rename(out(spec), join(root, spec.path));
    await writeFile(
      join(root, HERO_CAPTURE_PATH),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    published = true;
    return metadata;
  } finally {
    await browser?.close();
    await visual?.stop();
    // HERO_RETAIN_STAGING=1 keeps the frames for encoder tuning.
    if (published && process.env.HERO_RETAIN_STAGING !== "1")
      await rm(staging, { recursive: true });
    else if (published) console.error(`frames retained at ${staging}`);
    else console.error(`candidate retained at ${staging}`);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    const metadata = await captureHero(resolve("."));
    process.stdout.write(
      `captured hero media (${metadata.versionLabel}): ${Object.values(
        metadata.outputs,
      )
        .map((o) => `${o.path} ${Math.round(o.bytes / 1024)}K`)
        .join(", ")}\n`,
    );
  } catch (error) {
    process.stderr.write(`hero media capture: ${error.message}\n`);
    process.exitCode = 1;
  }
}
