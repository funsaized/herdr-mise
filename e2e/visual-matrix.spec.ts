// Browser acceptance for the visual playground matrix: every preset x
// supported count, the dinner theme URL, invalid-query fallback, storage
// isolation, emitted static fixtures, and liveness beyond the client stale
// timeout. Runs against the visual production build via the webServer config.
import { test, expect, type Page } from "@playwright/test";

const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const STATE_WORDS = {
  idle: "Idle — prepping",
  working: "Working — on the fire",
  blocked: "Blocked — at the pass",
  done: "Done — plated",
} as const;
const IDENTITIES = ["Codex", "Claude", "Hermes", "OpenClaw", "Gemini", "Aider"];

function expectedNames(preset: string, count: number) {
  return new Set(
    Array.from({ length: count }, (_, index) => {
      if (preset !== "mixed")
        return `mise-${String(index + 1).padStart(2, "0")}`;
      const cycle = Math.floor(index / IDENTITIES.length) + 1;
      return `${IDENTITIES[index % IDENTITIES.length]}${cycle > 1 ? `-${cycle}` : ""}`;
    }),
  );
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) =>
    errors.push(
      `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "request failed"}`,
    ),
  );
  return errors;
}

type MotionMetrics = {
  motion: {
    reduced: boolean;
    activeParticles: number;
    activeTransitions: number;
    activeBusserSweeps: number;
    continuous: boolean;
    preferenceChanges: number;
  };
  blockedIndicators: number;
  stateIndicators: Record<string, number>;
  endedEntries: number;
};
const sceneMetrics = (page: Page) =>
  page.evaluate(() =>
    (
      window as typeof window & { __miseSceneMetrics?: () => MotionMetrics }
    ).__miseSceneMetrics?.(),
  );

const placard = (page: Page) =>
  page.getByRole("status").filter({ hasText: "DEMO SERVICE" });

function boxesIntersect(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

test("reduced motion is static before blocked-scene startup in light and dinner themes", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dinner"]) {
    await page.goto(`/?preset=blocked&agents=1&theme=${theme}&stats`);
    await expect(placard(page)).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "mise-01, Blocked — at the pass, open details",
      }),
    ).toHaveCount(1);
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        motion: {
          reduced: true,
          activeParticles: 0,
          activeTransitions: 0,
          activeBusserSweeps: 0,
          continuous: false,
        },
        blockedIndicators: 1,
      });
  }
  expect(errors).toEqual([]);
});

test("runtime preference changes preserve mixed lifecycle truth in both directions", async ({
  page,
}) => {
  const errors = watchErrors(page),
    hero = (state: string) =>
      page.getByRole("button", { name: `Codex, ${state}, open details` });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?preset=mixed&agents=6&stats");
  await expect(hero("Working — on the fire")).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(async () => sceneMetrics(page))
    .toMatchObject({
      motion: { reduced: false, continuous: true, preferenceChanges: 1 },
    });
  await expect(hero("Blocked — at the pass")).toHaveCount(1, {
    timeout: 8_000,
  });
  await expect(page.getByLabel("Agent state announcements")).toHaveText(
    "Codex blocked, just now",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(async () => sceneMetrics(page))
    .toMatchObject({
      motion: {
        reduced: true,
        activeParticles: 0,
        activeTransitions: 0,
        activeBusserSweeps: 0,
        continuous: false,
        preferenceChanges: 2,
      },
      blockedIndicators: 3,
    });
  await expect(hero("Working — on the fire")).toHaveCount(1, {
    timeout: 5_000,
  });
  await expect(hero("Done — plated")).toHaveCount(1, { timeout: 5_000 });
  expect(errors).toEqual([]);
});

test("reduced startup preserves idle working blocked waiting and ended state indicators", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [preset, label] of [
    ["idle", "Idle — prepping"],
    ["working", "Working — on the fire"],
    ["blocked", "Blocked — at the pass"],
  ] as const) {
    await page.goto(`/?preset=${preset}&agents=1&stats`);
    await expect(
      page.getByRole("button", { name: `mise-01, ${label}, open details` }),
    ).toHaveCount(1);
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        motion: { reduced: true, continuous: false },
        stateIndicators: { [preset]: 1 },
        endedEntries: 0,
      });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?preset=ended&agents=1&stats");
  await expect(
    page.getByRole("status").filter({ hasText: "Waiting for agents" }),
  ).toBeVisible();
  await expect
    .poll(async () => sceneMetrics(page))
    .toMatchObject({
      motion: { reduced: true, continuous: false },
      endedEntries: 1,
    });
  await page.mouse.click((1280 - 368) / 2 + 3 * 4 + 16, (4 + 12) * 4 + 4);
  await expect(
    page.getByRole("complementary", { name: "mise-01 session summary" }),
  ).toContainText("86'D — SESSION ENDED");
  expect(errors).toEqual([]);
});

// Keyboard-cycle station focus and collect tooltip names until every
// expected station has been seen. Hit regions appear only after scene init,
// so the loop tolerates early presses that produce no tooltip.
async function collectStationNames(page: Page, expected: number) {
  const names = new Set<string>();
  const deadline = Date.now() + 25_000;
  while (names.size < expected && Date.now() < deadline) {
    await page.keyboard.press("ArrowRight");
    try {
      const name = await page
        .getByRole("tooltip")
        .locator("strong")
        .textContent({ timeout: 1_000 });
      if (name) names.add(name);
    } catch {
      /* scene hits not ready yet */
    }
  }
  return names;
}

for (const preset of ["idle", "working", "blocked", "done", "mixed"] as const) {
  for (const count of COUNTS) {
    test(`${preset} x ${count} renders every station`, async ({ page }) => {
      const errors = watchErrors(page);
      await page.goto(`/?preset=${preset}&agents=${count}`);
      await expect(placard(page)).toBeVisible();
      const names = await collectStationNames(page, count);
      expect([...names].sort()).toEqual(
        [...expectedNames(preset, count)].sort(),
      );
      if (preset !== "mixed") {
        await expect(page.getByRole("tooltip")).toContainText(
          STATE_WORDS[preset],
        );
      }
      expect(errors).toEqual([]);
    });
  }
}

for (const count of COUNTS) {
  test(`ended x ${count} empties the kitchen onto the 86 board`, async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?preset=ended&agents=${count}`);
    // All records are 86'd, so the truthful mode treatment is the empty pill.
    await expect(
      page.getByRole("status").filter({ hasText: "Waiting for agents" }),
    ).toBeVisible();
    // Ended records pass through the store before the first frame, so no
    // active station exists to focus.
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    // The 86 board draws the last three entries; the first drawn row's name
    // text position follows the scene layout math at 1280x720 (unit=4,
    // board x=(1280-368)/2, first row y=(4+12)*unit).
    await page.mouse.click((1280 - 368) / 2 + 3 * 4 + 16, (4 + 12) * 4 + 4);
    const summary = page.locator('aside[aria-label$="session summary"]');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("86'D — SESSION ENDED");
    await expect(summary).toContainText("Done — plated");
    expect(errors).toEqual([]);
  });
}

test("dinner theme URL selects the dark lighting setting", async ({ page }) => {
  await page.goto("/?preset=blocked&agents=12&theme=dinner");
  await expect(placard(page)).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("button", { name: "Dinner" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

// Stable acceptance calls this visual-product coverage: deterministic browser
// fixtures prove layout/theme behavior, never the presence of live agents.
for (const theme of ["light", "dinner"] as const) {
  for (const count of [1, 6, 12] as const) {
    test(`visual-product mixed x ${count} x ${theme}`, async ({ page }) => {
      const errors = watchErrors(page);
      await page.goto(`/?preset=mixed&agents=${count}&theme=${theme}`);
      await expect(placard(page)).toBeVisible();
      expect([...(await collectStationNames(page, count))].sort()).toEqual(
        [...expectedNames("mixed", count)].sort(),
      );
      await page.getByRole("button", { name: "Open settings" }).click();
      await expect(
        page.getByRole("button", {
          name: theme === "dinner" ? "Dinner" : "Light",
        }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(errors).toEqual([]);
    });
  }
}

test("idle cooks expose all four stable decorative poses", async ({ page }) => {
  await page.goto("/?preset=idle&agents=6&stats");
  await expect(placard(page)).toBeVisible();
  const readPoses = () =>
    page.evaluate(() => {
      const metrics = (
        window as typeof window & {
          __miseSceneMetrics?: () => { idlePoses: Record<string, string> };
        }
      ).__miseSceneMetrics?.();
      return metrics?.idlePoses ?? {};
    });
  await expect.poll(async () => Object.keys(await readPoses()).length).toBe(6);
  const first = await readPoses();
  expect(new Set(Object.values(first))).toEqual(
    new Set(["smoke", "recline", "sleep", "prep"]),
  );
  await page.waitForTimeout(500);
  expect(await readPoses()).toEqual(first);
});

test("invalid preset and count fall back to mixed x 6", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/?preset=bogus&agents=13");
  await expect(placard(page)).toBeVisible();
  const names = await collectStationNames(page, 6);
  expect([...names].sort()).toEqual([...expectedNames("mixed", 6)].sort());
  expect(errors).toEqual([]);
});

test("visual mode never touches persisted storage", async ({ page }) => {
  await page.goto("/?preset=working&agents=2");
  await expect(placard(page)).toBeVisible();
  const hint = page.getByRole("note");
  await expect(hint).toBeVisible();
  await hint.getByRole("button", { name: "Got it" }).click();
  await expect(hint).toHaveCount(0);
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("switch", { name: "Service bell" }).click();
  await page.getByRole("button", { name: "Dinner" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  const stored = await page.evaluate(() => ({
    settings: localStorage.getItem("herdr-mise:settings"),
    hint: localStorage.getItem("mise-bell-hint"),
    keys: Object.keys(localStorage),
  }));
  expect(stored.settings).toBeNull();
  expect(stored.hint).toBeNull();
  await page.reload();
  await expect(page.getByRole("note")).toBeVisible();
});

test("visual production serves fixtures and stays isolated from native and localhost sockets", async ({
  page,
  request,
}) => {
  const errors = watchErrors(page);
  const sockets: string[] = [],
    escapedRequests: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.host !== "127.0.0.1:4174" || url.port === "8686")
      escapedRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?preset=working&agents=6");
  await expect(placard(page)).toBeVisible();
  const figureBox = page.locator(".visualTuiFigure"),
    settings = page.getByRole("button", { name: "Open settings" });
  const figure = page.getByRole("img", {
    name: "Terminal herdr-mise kitchen with the persistent MISE — DEMO SERVICE label.",
  });
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute("src", "/tui-demo.gif");
  const defaultBox = await figureBox.boundingBox();
  expect(defaultBox).not.toBeNull();
  expect(defaultBox!.width).toBeGreaterThanOrEqual(319);
  expect(defaultBox!.width).toBeLessThanOrEqual(321);
  await figureBox.hover();
  await expect
    .poll(async () => (await figureBox.boundingBox())?.width)
    .toBeGreaterThan(defaultBox!.width);
  const hoverBox = await figureBox.boundingBox(),
    settingsBox = await settings.boundingBox();
  expect(hoverBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(boxesIntersect(hoverBox!, settingsBox!)).toBe(false);
  await settings.click();
  await expect(
    page.getByRole("complementary", { name: "Settings" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await page.mouse.move(400, 500);
  await expect
    .poll(async () => (await figureBox.boundingBox())?.width)
    .toBeLessThanOrEqual(321);

  await page.setViewportSize({ width: 901, height: 641 });
  await expect(figureBox).toBeVisible();
  await figureBox.hover();
  await expect
    .poll(async () => (await figureBox.boundingBox())?.width)
    .toBeGreaterThan(320);
  const boundaryFigureBox = await figureBox.boundingBox(),
    placardBox = await placard(page).boundingBox();
  expect(boundaryFigureBox).not.toBeNull();
  expect(placardBox).not.toBeNull();
  expect(boxesIntersect(boundaryFigureBox!, placardBox!)).toBe(false);

  await page.setViewportSize({ width: 800, height: 500 });
  await expect(figureBox).toBeHidden();
  expect((await request.get("/tui-demo.gif")).status()).toBe(200);
  expect((await request.get("/og.png")).status()).toBe(200);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://herdr-mise.s11a.com/og.png",
  );
  const socialAlt =
    "The herdr-mise demo kitchen showing agent stations and the DEMO SERVICE placard.";
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
    "content",
    socialAlt,
  );
  await expect(page.locator('meta[name="twitter:image:alt"]')).toHaveAttribute(
    "content",
    socialAlt,
  );
  await page.waitForTimeout(6_500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(placard(page)).toBeVisible();
  expect(sockets).toEqual([]);
  expect(escapedRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("reduced motion uses the emitted static poster", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?preset=blocked&agents=1");
  const figure = page.getByRole("img", {
    name: "Terminal herdr-mise kitchen with the persistent MISE — DEMO SERVICE label.",
  });
  await expect(figure).toBeVisible();
  await expect
    .poll(() =>
      figure.evaluate((image) => (image as HTMLImageElement).currentSrc),
    )
    .toContain("/tui-demo-poster.png");
  await expect(page.locator(".visualTuiFigure")).toHaveCSS(
    "transition-property",
    "none",
  );
  expect((await request.get("/tui-demo-poster.png")).status()).toBe(200);
});

test("semantic station controls are AX-only Tab exclusions and restore focus after details close", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?preset=working&agents=2");
  const station = page.getByRole("button", {
    name: "mise-01, Working — on the fire, open details",
  });
  await expect(station).toHaveAttribute("tabindex", "-1");
  await station.evaluate((element) => (element as HTMLButtonElement).click());
  const panel = page.getByRole("complementary", { name: "mise-01 details" });
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("complementary", { name: "mise-01 details" }),
  ).toHaveCount(0);
  await expect(station).toBeFocused();
});

test("settings restores focus to its visible trigger", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?preset=working&agents=1");
  const trigger = page.getByRole("button", { name: "Open settings" });
  await trigger.click();
  await expect(
    page.getByRole("complementary", { name: "Settings" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
