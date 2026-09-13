import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

const agents = Array.from({ length: 12 }, (_, index) => ({
  id: `agent-${index}`,
  name: `agent-${index}`,
  state:
    index === 3
      ? "blocked"
      : index === 4
        ? "done"
        : index % 2
          ? "idle"
          : "working",
  progress: 0.5,
  stateEnteredAt: new Date().toISOString(),
  accentIndex: index % 12,
  model: "codex",
  workspace: `/work/${index}`,
  session: { runtimeMs: 60_000, tickets: index },
}));
const snapshot = {
  version: 1,
  type: "snapshot",
  mode: "demo",
  sourceStatus: "unavailableSocket",
  agents,
};
const hiddenCpuMeasurementMs = 60_000;
async function mockFeed(page: Page) {
  await page.addInitScript((payload) => {
    class FeedSocket {
      static instance: FeedSocket;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      heartbeat: number | null = null;
      constructor() {
        FeedSocket.instance = this;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
          this.send(payload);
          this.heartbeat = window.setInterval(
            () => this.send({ version: 1, type: "heartbeat" }),
            1_000,
          );
        }, 20);
      }
      send(value: unknown) {
        this.onmessage?.({ data: JSON.stringify(value) });
      }
      pause() {
        if (this.heartbeat !== null) {
          clearInterval(this.heartbeat);
          this.heartbeat = null;
        }
      }
      close() {
        this.readyState = 3;
        this.pause();
      }
    }
    Object.defineProperty(window, "WebSocket", { value: FeedSocket });
    Object.defineProperty(window, "__miseFeed", {
      value: (value: unknown) => FeedSocket.instance.send(value),
    });
    Object.defineProperty(window, "__misePauseFeed", {
      value: () => FeedSocket.instance.pause(),
    });
  }, snapshot);
}
async function send(page: Page, value: unknown) {
  await page.evaluate(
    (payload) =>
      (window as unknown as { __miseFeed(value: unknown): void }).__miseFeed(
        payload,
      ),
    value,
  );
}
function metric(values: { name: string; value: number }[], name: string) {
  return values.find((item) => item.name === name)?.value ?? 0;
}
test.beforeEach(async ({ page }, testInfo) => {
  if (!testInfo.title.includes("opening handshake")) await mockFeed(page);
});

test("visual demo service at comp viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: 1_700_000_000_000 });
  await page.addInitScript(() =>
    localStorage.setItem("mise-bell-hint", "dismissed"),
  );
  await page.goto("/");
  await page.clock.runFor(500);
  await expect(page.getByText("DEMO SERVICE")).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page).toHaveScreenshot("demo-service.png", {
    maxDiffPixelRatio: 0.01,
    animations: "disabled",
  });
});
test("PR-1 cold start and stats", async ({ page }) => {
  const start = Date.now();
  await page.goto("/?stats");
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByText("DEMO SERVICE")).toBeVisible();
  const elapsed = Date.now() - start;
  console.log(`PR-1 cold start ${elapsed} ms`);
  expect(elapsed).toBeLessThanOrEqual(1500);
  await expect(page.getByLabel("Performance statistics")).toContainText(
    "draw calls",
  );
});
test("T-5.5/T-9.2 opening handshake times out into disconnected mode", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, { __openingStarted: 0, __openingClosed: 0 });
    class OpeningSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        (window as unknown as { __openingStarted: number }).__openingStarted =
          performance.now();
      }
      close() {
        this.readyState = 3;
        (window as unknown as { __openingClosed: number }).__openingClosed =
          performance.now();
      }
    }
    Object.defineProperty(window, "WebSocket", { value: OpeningSocket });
  });
  await page.goto("/");
  await expect(page.getByText("Connecting to Mise")).toBeVisible({
    timeout: 500,
  });
  await expect(
    page.getByRole("alert").getByText("Lost connection to Mise"),
  ).toBeVisible({ timeout: 3_500 });
  const timing = await page.evaluate(() => {
      const values = window as unknown as {
        __openingStarted: number;
        __openingClosed: number;
      };
      return {
        started: values.__openingStarted,
        closed: values.__openingClosed,
      };
    }),
    elapsed = timing.closed - timing.started;
  console.log(`T-5.5 opening-handshake disconnect ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThanOrEqual(3_000);
});
test("PR-2 transfer and WebGL graph budgets", async () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/check-bundle-budget.mjs"],
    { encoding: "utf8" },
  );
  console.log(output.trim());
  expect(output).toContain("Loaded WebGL JS");
});

test("station heartbeats are no-op and replacement disposes retained views", async ({
  page,
}) => {
  await page.goto("/?stats");
  await expect(page.locator("canvas")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __misePauseFeed(): void }).__misePauseFeed(),
  );
  const idle = {
    version: 1,
    type: "snapshot",
    mode: "demo",
    sourceStatus: "unavailableSocket",
    agents: agents.map((agent) => ({
      ...agent,
      state: "idle",
      progress: null,
    })),
  };
  await send(page, idle);
  await page.waitForTimeout(1_800);
  const before = await page.evaluate(() =>
    (
      window as unknown as {
        __miseSceneMetrics(): {
          stationRebuilds: number;
          stationDisposals: number;
        };
      }
    ).__miseSceneMetrics(),
  );
  await send(page, idle);
  await send(page, idle);
  await send(page, idle);
  await page.waitForTimeout(200);
  const unchanged = await page.evaluate(() =>
    (
      window as unknown as {
        __miseSceneMetrics(): {
          stationRebuilds: number;
          stationDisposals: number;
        };
      }
    ).__miseSceneMetrics(),
  );
  expect(unchanged.stationRebuilds).toBe(before.stationRebuilds);
  const replacements = {
    ...idle,
    agents: agents.map((agent, index) => ({
      ...agent,
      id: `replacement-${index}`,
    })),
  };
  await send(page, replacements);
  await page.waitForTimeout(200);
  const replaced = await page.evaluate(() =>
    (
      window as unknown as {
        __miseSceneMetrics(): {
          stationRebuilds: number;
          stationDisposals: number;
        };
      }
    ).__miseSceneMetrics(),
  );
  console.log(
    `Retained stations: heartbeat rebuilds ${unchanged.stationRebuilds - before.stationRebuilds}, replacement disposals ${replaced.stationDisposals - before.stationDisposals}`,
  );
  expect(replaced.stationDisposals - before.stationDisposals).toBe(12);
});
test("PR-3 browser event-to-next-frame scheduling (not source-to-pixel)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("DEMO SERVICE")).toBeVisible();
  const changed = {
    ...agents[0],
    state: "blocked",
    stateEnteredAt: new Date().toISOString(),
  };
  const latency = await page.evaluate(async (payload) => {
    const before = performance.now();
    (window as unknown as { __miseFeed(value: unknown): void }).__miseFeed({
      version: 1,
      type: "delta",
      mode: "demo",
      operation: "upsert",
      agent: payload,
    });
    await new Promise(requestAnimationFrame);
    return performance.now() - before;
  }, changed);
  console.log(
    `PR-3 browser event-to-next-frame ${latency.toFixed(2)} ms; excludes source transport and paint completion`,
  );
  expect(latency).toBeLessThanOrEqual(250);
});
test("visible scene renders only on lifecycle demand", async ({ page }) => {
  await page.addInitScript(() => {
    const native = requestAnimationFrame.bind(window);
    let frames = 0,
      lastFrame = -1;
    window.requestAnimationFrame = (callback) =>
      native((time) => {
        if (time !== lastFrame) frames++;
        lastFrame = time;
        callback(time);
      });
    Object.defineProperty(window, "__rafCount", { value: () => frames });
  });
  await page.goto("/?stats");
  await expect(page.locator("canvas")).toBeVisible();
  const counts = () =>
      page.evaluate(() => ({
        renders: (
          window as unknown as {
            __miseSceneMetrics(): { renderCount: number; rafCount: number };
          }
        ).__miseSceneMetrics().renderCount,
        raf: (
          window as unknown as {
            __miseSceneMetrics(): { renderCount: number; rafCount: number };
          }
        ).__miseSceneMetrics().rafCount,
        globalRaf: (window as unknown as { __rafCount(): number }).__rafCount(),
      })),
    measure = async (duration: number) => {
      const before = await counts();
      await page.waitForTimeout(duration);
      const after = await counts();
      return {
        renders: after.renders - before.renders,
        raf: after.raf - before.raf,
        globalRaf: after.globalRaf - before.globalRaf,
      };
    },
    working = { ...agents[0]!, state: "working", progress: 0.5 },
    idle = { ...working, state: "idle", progress: null };
  await send(page, { ...snapshot, agents: [working] });
  await page.waitForTimeout(1_200);
  const workingWindow = await measure(300);
  expect(workingWindow.renders).toBeGreaterThan(0);
  expect(workingWindow.raf).toBeGreaterThan(0);

  const transitionBefore = await counts();
  await send(page, {
    version: 1,
    type: "delta",
    mode: "demo",
    operation: "upsert",
    agent: idle,
  });
  await expect
    .poll(async () => (await counts()).renders, { timeout: 250 })
    .toBeGreaterThan(transitionBefore.renders);
  const transitionWindow = await measure(300);
  expect(transitionWindow.renders).toBeGreaterThan(0);

  await send(page, {
    ...snapshot,
    agents: agents.map((agent) => ({
      ...agent,
      state: "idle",
      progress: null,
    })),
  });
  await page.waitForTimeout(1_200);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const before = await cdp.send("Performance.getMetrics"),
    countsBefore = await counts(),
    startedAt = Date.now();
  await page.waitForTimeout(2_000);
  const after = await cdp.send("Performance.getMetrics"),
    wall = (Date.now() - startedAt) / 1000,
    countsAfter = await counts(),
    cpu =
      ((metric(after.metrics, "TaskDuration") -
        metric(before.metrics, "TaskDuration")) /
        wall) *
      100;
  console.log(
    `Visible idle fixed 2000 ms window — baseline: 1.816% CPU, 15 renders, 121 scene rAF; demand-driven: ${cpu.toFixed(3)}% CPU, ${countsAfter.renders - countsBefore.renders} renders, ${countsAfter.raf - countsBefore.raf} scene rAF (${countsAfter.globalRaf - countsBefore.globalRaf} global)`,
  );
  expect(countsAfter.renders - countsBefore.renders).toBeLessThanOrEqual(4);
  expect(countsAfter.raf - countsBefore.raf).toBeLessThanOrEqual(4);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(300);
  const reducedIdle = await measure(2_000);
  expect(reducedIdle.renders).toBeLessThanOrEqual(1);
  expect(reducedIdle.raf).toBeLessThanOrEqual(1);
  expect(reducedIdle.globalRaf).toBeLessThanOrEqual(1);

  await send(page, { ...snapshot, agents: [] });
  await page.waitForTimeout(300);
  const empty = await measure(2_000);
  expect(empty.renders).toBeLessThanOrEqual(1);
  expect(empty.raf).toBeLessThanOrEqual(1);
  expect(empty.globalRaf).toBeLessThanOrEqual(1);

  await send(page, {
    ...snapshot,
    agents: [
      {
        ...working,
        state: "blocked",
        stateEnteredAt: new Date().toISOString(),
      },
    ],
  });
  await page.waitForTimeout(200);
  const blockedBefore = await counts();
  await expect
    .poll(async () => (await counts()).renders, { timeout: 1_500 })
    .toBeGreaterThan(blockedBefore.renders);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await send(page, { ...snapshot, agents: [] });
  await page.waitForTimeout(300);
  const feedBefore = await counts();
  await send(page, {
    version: 1,
    type: "delta",
    mode: "demo",
    operation: "upsert",
    agent: working,
  });
  await expect
    .poll(async () => (await counts()).renders, { timeout: 250 })
    .toBeGreaterThan(feedBefore.renders);
});
test("PR-4 hidden CPU and resume", async ({ page }) => {
  test.setTimeout(75_000);
  await page.addInitScript(() => {
    const native = requestAnimationFrame.bind(window);
    let frames = 0,
      lastFrame = -1;
    window.requestAnimationFrame = (callback) =>
      native((time) => {
        if (time !== lastFrame) frames++;
        lastFrame = time;
        callback(time);
      });
    Object.defineProperty(window, "__rafCount", { value: () => frames });
  });
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const rafBefore = await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    return (window as unknown as { __rafCount(): number }).__rafCount();
  });
  await page.waitForTimeout(1_000);
  const before = await cdp.send("Performance.getMetrics"),
    start = Date.now();
  await page.waitForTimeout(hiddenCpuMeasurementMs);
  const after = await cdp.send("Performance.getMetrics"),
    wall = (Date.now() - start) / 1000,
    cpu =
      ((metric(after.metrics, "TaskDuration") -
        metric(before.metrics, "TaskDuration")) /
        wall) *
      100,
    rafAfter = await page.evaluate(() =>
      (window as unknown as { __rafCount(): number }).__rafCount(),
    );
  const resume = await page.evaluate(async () => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    const start = performance.now();
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });
  console.log(
    `PR-4 hidden CPU fixed ${hiddenCpuMeasurementMs} ms window: ${cpu.toFixed(3)}% of one core, hidden rAF ${rafAfter - rafBefore}, resume ${resume.toFixed(1)} ms`,
  );
  expect(rafAfter - rafBefore).toBeLessThanOrEqual(1);
  expect(resume).toBeLessThanOrEqual(100);
  expect(cpu).toBeLessThanOrEqual(0.15);
});
test("PR-6 production coalescer wire rate", async () => {
  const output = execFileSync(
    "cargo",
    [
      "test",
      "-p",
      "herdr-mise-server",
      "feed::tests::twelve_record_chatty_source_stays_below_wire_budget",
      "--",
      "--exact",
      "--nocapture",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  console.log(output.trim());
});
