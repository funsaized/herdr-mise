import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCaptureTools,
  createStaging,
  openVisual,
  remainingFrameDelay,
  startVisualServer,
  verifyCommittedSource,
} from "./capture-media.mjs";
import {
  attentionStoryboard,
  captureDurationMs,
  captureFrameCount,
  captureQuery,
  gifFrameRate,
  mediaDurationBoundsSeconds,
  mediaOutputs,
  outputDimensions,
  sourceDimensions,
} from "./readme-media-config.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baseUrl = "http://127.0.0.1:4173";

// Guard before any staging directory, dynamic capture module, or process.
// The publishing CLI intentionally exposes no way to bypass it.
const sourceCommit = verifyCommittedSource(root);

function requestedProfile(argv) {
  const index = argv.indexOf("--profile");
  return index === -1 ? "web" : argv[index + 1];
}

async function addCaption(page, text) {
  await page.evaluate((text) => {
    document.querySelector(".visualTuiFigure")?.remove();
    const shell = document.querySelector(".appShell");
    if (!shell) throw new Error("capture app shell is missing");
    const caption = document.createElement("div");
    caption.id = "capture-caption";
    caption.className = "captureCaption";
    caption.textContent = text;
    shell.append(caption);
  }, text);
}

async function setCaption(page, text) {
  await page.locator("#capture-caption").evaluate((node, value) => {
    node.textContent = value;
  }, text);
}

async function captureReadmeMedia(sourceCommit) {
  const { encode, probe, digest } = createCaptureTools(root);
  const { chromium } = await import("@playwright/test");
  const output = join(root, "docs", "assets");
  const staging = await createStaging(root, "web");
  const frames = join(staging, "frames");
  await mkdir(frames);
  let browser;
  let stopServer = async () => {};

  try {
    const visual = await startVisualServer(root, baseUrl);
    stopServer = visual.stop;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: sourceDimensions,
      deviceScaleFactor: 1,
    });
    const diagnostics = [];
    page.on("console", (message) => {
      if (message.type() === "error")
        diagnostics.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => diagnostics.push(`page: ${error.message}`));
    page.on("requestfailed", (request) =>
      diagnostics.push(
        `request: ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
      ),
    );

    await openVisual(page, baseUrl, "preset=mixed&agents=6&theme=light");
    await page.screenshot({
      path: join(staging, "working-service-1280x720.png"),
    });
    await openVisual(page, baseUrl, "preset=mixed&agents=6&theme=dinner");
    await page.screenshot({
      path: join(staging, "blocked-dinner-service-1280x720.png"),
    });
    await openVisual(page, baseUrl, "preset=mixed&agents=6&theme=light");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("complementary", { name: "Settings" }).waitFor();
    await page.screenshot({ path: join(staging, "settings-1280x720.png") });

    await openVisual(page, baseUrl, captureQuery);
    const demoPlacard = page.getByText("DEMO SERVICE", { exact: true });
    await demoPlacard.waitFor();
    const stations = page
      .getByRole("navigation", { name: "Agent stations" })
      .getByRole("button");
    if ((await stations.count()) !== 6)
      throw new Error("attention story did not start with six cooks");
    await page
      .getByRole("button", {
        name: "Codex, Working — on the fire, open details",
      })
      .waitFor();
    const observedStates = ["working"];
    let blockedFrame;
    const startedAt = Date.now();
    for (let index = 0; index < captureFrameCount; index++) {
      const blocked = page.getByRole("button", {
        name: /Codex, Blocked —.*open details/,
      });
      if (observedStates.length === 1 && (await blocked.count())) {
        observedStates.push("blocked");
        await blocked.evaluate((element) => element.click());
        const details = page.getByRole("complementary", {
          name: "Codex details",
        });
        await details.waitFor();
        if (!(await details.textContent())?.includes("checkout-api"))
          throw new Error("Codex details did not identify checkout-api");
        await addCaption(page, attentionStoryboard[1].caption);
        blockedFrame = index;
      }
      const resumed = page.getByRole("button", {
        name: "Codex, Working — on the fire, open details",
      });
      if (observedStates.length === 2 && (await resumed.count())) {
        observedStates.push("working");
        await setCaption(page, attentionStoryboard[2].caption);
      }
      await page.screenshot({
        path: join(frames, `frame-${String(index).padStart(3, "0")}.png`),
      });
      await page.waitForTimeout(
        remainingFrameDelay(startedAt, index + 1, Date.now()),
      );
    }
    if (observedStates.join(",") !== "working,blocked,working")
      throw new Error(`incomplete semantic story: ${observedStates.join(",")}`);
    if (blockedFrame === undefined)
      throw new Error("blocked poster frame missing");
    await demoPlacard.waitFor();
    if (diagnostics.length)
      throw new Error(`browser diagnostics:\n${diagnostics.join("\n")}`);

    const input = join(frames, "frame-%03d.png"),
      scale = `scale=${outputDimensions.width}:${outputDimensions.height}:flags=lanczos`,
      candidates = Object.fromEntries(
        Object.entries(mediaOutputs).map(([key, value]) => [
          key,
          join(staging, value.path.split("/").at(-1)),
        ]),
      );
    encode([
      "-framerate",
      String(gifFrameRate),
      "-i",
      input,
      "-vf",
      `${scale},split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
      "-loop",
      "0",
      candidates.gif,
    ]);
    encode([
      "-framerate",
      String(gifFrameRate),
      "-i",
      input,
      "-vf",
      scale,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      candidates.mp4,
    ]);
    encode([
      "-framerate",
      String(gifFrameRate),
      "-i",
      input,
      "-vf",
      scale,
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "30",
      candidates.webm,
    ]);
    encode([
      "-i",
      join(frames, `frame-${String(blockedFrame).padStart(3, "0")}.png`),
      "-vf",
      scale,
      "-frames:v",
      "1",
      candidates.poster,
    ]);

    const metadataOutputs = {};
    for (const name of [
      "working-service-1280x720.png",
      "blocked-dinner-service-1280x720.png",
      "settings-1280x720.png",
    ]) {
      if (!(await stat(join(staging, name))).size)
        throw new Error(`${name} output is empty`);
    }
    for (const [key, config] of Object.entries(mediaOutputs)) {
      const path = candidates[key],
        file = await stat(path),
        details = probe(path),
        video = details.streams.find((stream) => stream.codec_type === "video"),
        duration = Number(details.format.duration ?? 0);
      if (!file.size || !video)
        throw new Error(`${key} output is empty or invalid`);
      if (
        video.codec_name !== config.codec ||
        video.width !== outputDimensions.width ||
        video.height !== outputDimensions.height
      )
        throw new Error(
          `${key} codec or dimensions do not match configuration`,
        );
      if (
        key !== "poster" &&
        (duration < mediaDurationBoundsSeconds.min ||
          duration > mediaDurationBoundsSeconds.max)
      )
        throw new Error(
          `${key} duration ${duration} is outside ${mediaDurationBoundsSeconds.min}–${mediaDurationBoundsSeconds.max} seconds`,
        );
      if (
        (key === "mp4" || key === "webm") &&
        details.streams.some((stream) => stream.codec_type === "audio")
      )
        throw new Error(`${key} unexpectedly contains audio`);
      metadataOutputs[key] = {
        path: config.path,
        codec: config.codec,
        durationSeconds: key === "poster" ? null : duration,
        bytes: file.size,
        sha256: await digest(path),
      };
    }
    const metadata = {
      schema: "web-demo-capture-v1",
      capturedAt: new Date().toISOString(),
      sourceCommit,
      query: captureQuery,
      scenario: attentionStoryboard,
      provenance: "deterministic client visual harness demo",
      sourceDimensions,
      outputDimensions,
      frameRate: gifFrameRate,
      frameCount: captureFrameCount,
      durationSeconds: captureDurationMs / 1_000,
      semanticStatesObserved: observedStates,
      outputs: metadataOutputs,
    };
    await writeFile(
      join(staging, "web-demo.capture.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );

    for (const name of [
      "working-service-1280x720.png",
      "blocked-dinner-service-1280x720.png",
      "settings-1280x720.png",
      ...Object.values(mediaOutputs).map(({ path }) => path.split("/").at(-1)),
    ])
      await rename(join(staging, name), join(output, name));
    await rename(
      join(staging, "web-demo.capture.json"),
      join(root, "scripts", "web-demo.capture.json"),
    );
    await rm(staging, { recursive: true });
    console.log("captured and validated browser README media");
  } finally {
    await browser?.close();
    await stopServer();
    try {
      await stat(staging);
      console.error(`candidate retained at ${staging}`);
    } catch {
      // Published successfully.
    }
  }
}

if (requestedProfile(process.argv.slice(2)) === "product") {
  const { captureProduct } = await import("./capture-product-media.mjs");
  await captureProduct(root, sourceCommit);
} else {
  await captureReadmeMedia(sourceCommit);
}
