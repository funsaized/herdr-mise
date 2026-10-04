import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createCaptureTools,
  createStaging,
  startVisualServer,
  verifyCommittedSource,
} from "./capture-media.mjs";
import { validateProductMedia } from "./check-product-media.mjs";
import {
  PRODUCT_DEMO_CAPTURE_PATH,
  PRODUCT_DEMO_SCHEMA,
  PRODUCT_DEMO_PROVENANCE,
  TUI_DEMO_DISPLAYED_MEDIA,
  TUI_DEMO_INPUT,
  cuesFor,
  deliverables,
  frameRate,
  outputDimensions,
  readSourceVersion,
  sourceDimensions,
  storyboard,
  transcript,
  versionLabel,
  webVtt,
} from "./product-demo-config.mjs";
import {
  prepareProductScene,
  productSceneClockCeiling,
  setProductCaption,
  PRODUCT_SETTLE_MS,
  PRODUCT_ATTENTION_BLOCKED_MS,
} from "./product-demo-scenes.mjs";

// This exported publishing entry point is guarded too; importing it does no work.
export async function captureProduct(root, expectedCommit) {
  const sourceCommit = verifyCommittedSource(root);
  if (expectedCommit && expectedCommit !== sourceCommit)
    throw new Error("source commit changed before capture");
  const { chromium } = await import("@playwright/test");
  const tools = createCaptureTools(root);
  const version = readSourceVersion(root);
  const label = versionLabel(version, sourceCommit);
  const rendered = storyboard.map((cue) => ({
    ...cue,
    caption: cue.scene === "installation" ? label : cue.caption,
  }));
  const staging = await createStaging(root, "product");
  // A complete candidate repository layout lets the same validator check staging.
  const assets = join(staging, "docs/assets");
  await mkdir(assets, { recursive: true });
  await mkdir(join(staging, "scripts"));
  await mkdir(join(staging, "server"));
  await writeFile(
    join(staging, "server/Cargo.toml"),
    await readFile(join(root, "server/Cargo.toml")),
  );
  const diagnostics = [];
  let browser;
  let visual;
  try {
    const tui = JSON.parse(
      await readFile(join(root, TUI_DEMO_INPUT.capturePath), "utf8"),
    );
    // A headless (v2) recording is played as video by the comparison figure.
    const displayed =
      tui.schema === "demo-capture-v1" ? [] : TUI_DEMO_DISPLAYED_MEDIA;
    for (const path of [
      TUI_DEMO_INPUT.path,
      TUI_DEMO_INPUT.capturePath,
      ...displayed.map((media) => media.path),
    ])
      await writeFile(join(staging, path), await readFile(join(root, path)));
    const displayedMedia = [];
    for (const { path } of displayed)
      displayedMedia.push({
        path,
        bytes: (await stat(join(root, path))).size,
        sha256: await tools.digest(join(root, path)),
      });
    const metadata = {
      schema: PRODUCT_DEMO_SCHEMA,
      capturedAt: new Date().toISOString(),
      sourceCommit,
      provenance: PRODUCT_DEMO_PROVENANCE,
      version,
      versionLabel: label,
      frameRate,
      sourceDimensions,
      outputDimensions,
      storyboard: rendered,
      inputs: {
        tuiDemo: {
          ...TUI_DEMO_INPUT,
          bytes: (await stat(join(root, TUI_DEMO_INPUT.path))).size,
          sha256: await tools.digest(join(root, TUI_DEMO_INPUT.path)),
          captureSha256: await tools.digest(
            join(root, TUI_DEMO_INPUT.capturePath),
          ),
          sourceSha256: tui.source_sha256,
          releaseBinarySha256: tui.release_binary_sha256,
          posterSha256: tui.output.poster_sha256,
          provenance: "prerecorded demo footage",
          originalCapture: tui,
          ...(displayed.length ? { displayedMedia } : {}),
        },
      },
      outputs: {},
    };
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
    page.on("requestfailed", (request) =>
      diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`),
    );
    const time = Date.parse("2026-01-01T00:00:00Z");
    await page.clock.install({ time });
    await page.clock.pauseAt(time);
    const frames = join(staging, "frames");
    await mkdir(frames);
    for (const cue of rendered) {
      await prepareProductScene(
        page,
        baseUrl,
        cue.scene,
        `product-${cue.scene}`,
      );
      await setProductCaption(page, cue.caption, `product-${cue.scene}`);
      let clockMs =
        cue.scene === "blocked" || cue.scene === "details"
          ? PRODUCT_ATTENTION_BLOCKED_MS
          : PRODUCT_SETTLE_MS;
      // Bounded clock: editorial seconds never advance the attention timers.
      // Screenshot work may take longer than playback; encoded fps is authoritative.
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
          productSceneClockCeiling(cue.scene) - clockMs,
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
    for (const clip of deliverables) {
      const input = [
        "-framerate",
        String(frameRate),
        "-start_number",
        String(clip.start * frameRate),
        "-i",
        join(frames, "frame-%04d.png"),
      ];
      const limit = ["-frames:v", String(clip.durationSeconds * frameRate)];
      const record = {
        kind: clip.kind,
        durationSeconds: clip.durationSeconds,
        posterSeconds: clip.posterSeconds,
        cues: cuesFor(clip, rendered),
        assets: {},
      };
      for (const [format, spec] of Object.entries(clip.outputs)) {
        const path = join(staging, spec.path);
        if (format === "vtt") await writeFile(path, webVtt(clip, rendered));
        else if (format === "txt")
          await writeFile(path, transcript(clip, label, rendered));
        else if (format === "poster")
          tools.encode([
            "-i",
            join(
              frames,
              `frame-${String((clip.start + clip.posterSeconds) * frameRate).padStart(4, "0")}.png`,
            ),
            "-vf",
            scale,
            "-frames:v",
            "1",
            path,
          ]);
        else if (format === "gif") {
          // Two passes: a one-pass split/palettegen graph drops the frames it
          // buffers while the palette is computed (every loop came out 9s).
          const palette = `${path}.palette.png`;
          tools.encode([
            ...input,
            ...limit,
            "-vf",
            `${scale},palettegen=max_colors=128`,
            "-update",
            "1",
            palette,
          ]);
          tools.encode([
            ...input,
            "-i",
            palette,
            ...limit,
            "-lavfi",
            `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
            "-loop",
            "0",
            path,
          ]);
          await rm(palette, { force: true });
        } else
          tools.encode([
            ...input,
            ...limit,
            "-vf",
            scale,
            "-an",
            "-c:v",
            format === "mp4" ? "libx264" : "libvpx-vp9",
            ...(format === "mp4"
              ? ["-pix_fmt", "yuv420p", "-movflags", "+faststart"]
              : ["-b:v", "0", "-crf", "30"]),
            path,
          ]);
        record.assets[format] = {
          path: spec.path,
          codec: spec.codec,
          bytes: (await stat(path)).size,
          sha256: await tools.digest(path),
          durationSeconds: spec.duration
            ? Number(tools.probe(path).format.duration)
            : null,
        };
      }
      metadata.outputs[clip.id] = record;
    }
    await writeFile(
      join(staging, PRODUCT_DEMO_CAPTURE_PATH),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await validateProductMedia(staging, metadata, {
      ...tools,
      commitExists: (commit) =>
        tools.run("git", ["cat-file", "-e", `${commit}^{commit}`]) === "",
    });
    // Only a validated complete package is published; failed candidates stay intact.
    for (const clip of deliverables)
      for (const spec of Object.values(clip.outputs))
        await rename(join(staging, spec.path), join(root, spec.path));
    await rename(
      join(staging, PRODUCT_DEMO_CAPTURE_PATH),
      join(root, PRODUCT_DEMO_CAPTURE_PATH),
    );
    await rm(staging, { recursive: true });
    console.log(`captured and validated product media (${basename(staging)})`);
  } finally {
    await browser?.close();
    await visual?.stop();
    try {
      await stat(staging);
      await writeFile(
        join(staging, "diagnostics.json"),
        JSON.stringify(
          { browser: diagnostics, server: visual?.log() ?? "" },
          null,
          2,
        ),
      );
      console.error(`candidate retained at ${staging}`);
    } catch (error) {
      if (error.code !== "ENOENT")
        console.error(`could not retain diagnostics: ${error.message}`);
    }
  }
}
