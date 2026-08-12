import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  captureFrameCount,
  gifFrameRate,
  remainingFrameDelay,
} from "./readme-media-config.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(root, "docs", "assets");
const baseUrl = "http://127.0.0.1:4173";
const frames = await mkdtemp(join(tmpdir(), "herdr-mise-readme-"));
let server;
let browser;

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
  // Negative PIDs target the detached process group on the supported POSIX hosts.
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  await Promise.race([
    exited,
    new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      server.kill("SIGKILL");
    }
    await exited;
  }
}

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      /* Vite is still starting. */
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`visual server did not become ready at ${baseUrl}`);
}

async function openVisual(page, query) {
  await page.goto(`${baseUrl}/?${query}`, { waitUntil: "networkidle" });
  await page.locator("canvas").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  const dismiss = page.getByRole("button", { name: "Got it" });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.waitForTimeout(450);
}

async function captureFrames(page, query, count, start, actions = {}) {
  await openVisual(page, query);
  const startedAt = Date.now();
  for (let index = 0; index < count; index++) {
    await actions[index]?.();
    const number = String(start + index).padStart(3, "0");
    await page.screenshot({ path: join(frames, `frame-${number}.png`) });
    await page.waitForTimeout(
      remainingFrameDelay(startedAt, index + 1, Date.now()),
    );
  }
  return start + count;
}

try {
  await mkdir(output, { recursive: true });
  server = spawn(
    "npm",
    [
      "--prefix",
      "client",
      "run",
      "dev:visual",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "4173",
      "--strictPort",
    ],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverLog = "";
  server.stdout.on("data", (chunk) => {
    serverLog += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverLog += chunk;
  });
  server.on("exit", (code) => {
    if (code && code !== 0) console.error(serverLog.trim());
  });
  await waitForServer();

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
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

  await openVisual(page, "preset=mixed&agents=6&theme=light");
  await page.screenshot({ path: join(output, "working-service-1280x720.png") });

  await openVisual(page, "preset=mixed&agents=6&theme=dinner");
  await page.screenshot({
    path: join(output, "blocked-dinner-service-1280x720.png"),
  });

  await openVisual(page, "preset=mixed&agents=6&theme=light");
  const liveRegion = page.locator(".liveRegion");
  const liveSemantics = await liveRegion.evaluate((node) => ({
    label: node.getAttribute("aria-label"),
    live: node.getAttribute("aria-live"),
    atomic: node.getAttribute("aria-atomic"),
  }));
  if (
    liveSemantics.label !== "Agent state announcements" ||
    liveSemantics.live !== "polite" ||
    liveSemantics.atomic !== "true"
  ) {
    throw new Error(
      `unexpected live-region semantics: ${JSON.stringify(liveSemantics)}`,
    );
  }
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("complementary", { name: "Settings" });
  await settings.waitFor({ state: "visible" });
  await page.getByRole("switch", { name: "Service bell" }).focus();
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open settings" }).click();
  await settings.waitFor({ state: "visible" });
  await page.screenshot({ path: join(output, "settings-1280x720.png") });

  // Hero station center from computeLayout(1280, 720, 6 agents); the waitFor
  // fails the capture loudly if a layout change moves the click off the agent.
  const heroDetail = page.getByRole("complementary", { name: "Codex details" });
  await captureFrames(
    page,
    "preset=mixed&agents=6&theme=light",
    captureFrameCount,
    0,
    {
      [Math.round(gifFrameRate * 0.5)]: async () => {
        await page.mouse.click(448, 406);
        await heroDetail.waitFor({ state: "visible" });
        await page.mouse.move(20, 700);
      },
      [Math.round(gifFrameRate * 3)]: async () => {
        await page.keyboard.press("Escape");
        await heroDetail.waitFor({ state: "hidden" });
      },
    },
  );

  if (diagnostics.length)
    throw new Error(`browser diagnostics:\n${diagnostics.join("\n")}`);

  const gif = join(output, "herdr-mise-demo.gif");
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      String(gifFrameRate),
      "-i",
      join(frames, "frame-%03d.png"),
      "-vf",
      `fps=${gifFrameRate},scale=960:-1:flags=neighbor,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
      "-loop",
      "0",
      gif,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (ffmpeg.error)
    throw new Error(`ffmpeg could not start: ${ffmpeg.error.message}`);
  if (ffmpeg.status !== 0) throw new Error(`ffmpeg failed: ${ffmpeg.stderr}`);

  console.log("captured docs/assets/working-service-1280x720.png");
  console.log("captured docs/assets/blocked-dinner-service-1280x720.png");
  console.log("captured docs/assets/settings-1280x720.png");
  console.log("captured docs/assets/herdr-mise-demo.gif");
} finally {
  await browser?.close();
  await stopServer();
  await rm(frames, { recursive: true, force: true });
}
