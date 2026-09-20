import { test, expect } from "@playwright/test";
import { computeLayout } from "../client/src/scene/layout";
import {
  watchErrors,
  sceneMetrics,
  placard,
  boxesIntersect,
  cycleSceneFocus,
  assertResponsiveScene,
} from "./visual-helpers";

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
        name: /mise-01, Blocked — at the pass.*open details/,
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

test("atmosphere switches off room extras without changing blocked truth", async ({
  page,
}) => {
  const errors = watchErrors(page),
    passTreatments: number[] = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dinner"]) {
    await page.goto(`/?preset=blocked&agents=1&theme=${theme}&stats`);
    await expect(placard(page)).toBeVisible();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        atmosphere: { shelf: 2 },
        blockedIndicators: 1,
        board: { headers: ["COOK", "MISE TIME"] },
      });
    const initial = await sceneMetrics(page);
    expect(initial?.atmosphere.window).toBeGreaterThan(0);
    expect(initial?.atmosphere.pass).toBeGreaterThan(0);
    passTreatments.push(initial!.atmosphere.pass);

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        atmosphere: {
          window: 0,
          shelf: 0,
          pass: 0,
          workingContact: 0,
          freezerAccents: 0,
        },
        blockedIndicators: 1,
        board: { headers: ["COOK", "MISE TIME"] },
        motion: {
          reduced: true,
          activeParticles: 0,
          activeTransitions: 0,
          activeBusserSweeps: 0,
          continuous: false,
        },
      });
  }
  expect(passTreatments[1]).toBeGreaterThan(passTreatments[0]!);
  expect(errors).toEqual([]);
});

test("runtime preference changes preserve mixed lifecycle truth in both directions", async ({
  page,
}) => {
  const errors = watchErrors(page),
    hero = (state: string) =>
      page.getByRole("button", { name: `Codex, ${state}, open details` });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?preset=mixed&agents=7&stats");
  await expect(hero("Working — on the fire")).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(async () => sceneMetrics(page))
    .toMatchObject({
      motion: { reduced: false, continuous: true, preferenceChanges: 1 },
    });
  await expect(
    page.getByRole("button", { name: /Codex, Blocked — at the pass/ }),
  ).toHaveCount(1, {
    timeout: 8_000,
  });
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
    });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const indicators = (
            window as typeof window & {
              __miseSceneMetrics?: () => { blockedIndicators: number };
            }
          ).__miseSceneMetrics?.().blockedIndicators,
          controls = document.querySelectorAll(
            '.stationA11yMirror button[aria-label*="Blocked —"]',
          ).length;
        return controls > 0 && indicators === controls;
      }),
    )
    .toBe(true);
  await expect(hero("Working — on the fire")).toHaveCount(1, {
    timeout: 5_000,
  });
  await expect(hero("Done — plated")).toHaveCount(1, { timeout: 5_000 });
  await expect(hero("Working — on the fire")).toHaveCount(1, {
    timeout: 5_000,
  });
  const stations = page.getByRole("navigation", { name: "Agent stations" });
  await expect(
    stations.getByRole("button", { name: /OpenClaw, Ended/ }),
  ).toBeAttached({ timeout: 5_000 });
  await expect(
    stations.getByRole("button", { name: /Gemini, Ended/ }),
  ).toBeAttached();
  const freezer = page.getByRole("button", { name: "Freezer" });
  await freezer.click();
  await expect(freezer).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => sceneMetrics(page))
    .toMatchObject({ view: "freezer", endedEntries: 2, visibleSpirits: 2 });
  expect(errors).toEqual([]);
});

test("reduced motion startup preserves idle working blocked waiting and ended state indicators", async ({
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
      page.getByRole("button", {
        name: new RegExp(`mise-01, ${label}.*open details`),
      }),
    ).toHaveCount(1);
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        motion: { reduced: true, activeParticles: 0, continuous: false },
        stateIndicators: { [preset]: 1 },
        endedEntries: 0,
      });
    if (preset === "working") {
      const visuals = (await sceneMetrics(page))?.stationVisuals;
      await page.waitForTimeout(300);
      expect((await sceneMetrics(page))?.stationVisuals).toEqual(visuals);
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?preset=ended&agents=1&stats");
  await expect(placard(page)).toBeVisible();
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

test("native freezer control renders only visible board spirits and preserves Escape order", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?preset=ended&agents=12&stats");
  const freezer = page.getByRole("button", { name: "Freezer" });
  await expect(freezer).toHaveAttribute("aria-pressed", "false");
  await page.mouse.click((1280 - 368) / 2 + 3 * 4 + 16, (4 + 12) * 4 + 4);
  await expect(
    page.locator('aside[aria-label$="session summary"]'),
  ).toBeVisible();
  await freezer.click();
  await expect(
    page.locator('aside[aria-label$="session summary"]'),
  ).toHaveCount(0);
  await expect(freezer).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => sceneMetrics(page))
    .toMatchObject({ view: "freezer", endedEntries: 12, visibleSpirits: 12 });
  await expect(
    page.getByRole("navigation", { name: "Ended chefs" }),
  ).toBeAttached();
  await expect(
    page.getByRole("navigation", { name: "Ended chefs" }).getByRole("button"),
  ).toHaveCount(12);
  await expect(page.getByLabel("Agent state announcements")).toHaveText(
    "Freezer, 12 decorative spirits, 12 inspectable sessions",
  );
  const newest = page
    .getByRole("navigation", { name: "Ended chefs" })
    .getByRole("button")
    .first();
  await newest.focus();
  await newest.press("Enter");
  await expect(
    page.locator('aside[aria-label$="session summary"]'),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('aside[aria-label$="session summary"]'),
  ).toHaveCount(0);
  await expect(freezer).toHaveAttribute("aria-pressed", "true");
  await expect(newest).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(freezer).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () => sceneMetrics(page))
    .toMatchObject({ view: "kitchen" });
  expect(errors).toEqual([]);
});

test("responsive mixed scenes keep station text focus and mobile chrome bounded", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 390, height: 844 },
    { width: 720, height: 720 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ])
    for (const count of [1, 6, 12]) {
      await page.setViewportSize(viewport);
      await page.goto(`/?preset=mixed&agents=${count}&stats`);
      await assertResponsiveScene(page, count, true);
    }
  expect(errors).toEqual([]);
});

test("responsive mixed focus follows live stations onto the 86 board", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?preset=mixed&agents=6&stats");
  await expect
    .poll(
      async () => {
        const metrics = await sceneMetrics(page);
        return [
          Object.keys(metrics?.stationCells ?? {}).length,
          metrics?.endedEntries,
        ];
      },
      { timeout: 20_000 },
    )
    .toEqual([4, 2]);

  for (let pass = 0; pass < 2; pass++) {
    const focused = await cycleSceneFocus(page, 6),
      metrics = (await sceneMetrics(page))!;
    expect([...focused.stationIds].sort()).toEqual(
      Object.keys(metrics.stationCells).sort(),
    );
    expect([...focused.boardIds].sort()).toEqual(
      metrics.board.rows.map(({ id }) => id).sort(),
    );
  }
});

test("idle cooks expose all five stable decorative poses without continuous motion", async ({
  page,
}) => {
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
    new Set([
      "coffeeBreak",
      "lean",
      "sleep",
      "toqueAdjust",
      "ticketRailGlance",
    ]),
  );
  await expect
    .poll(async () => (await sceneMetrics(page))?.motion.continuous)
    .toBe(false);
  await page.waitForTimeout(500);
  expect(await readPoses()).toEqual(first);
});

test("working cooks drive continuous scene motion", async ({ page }) => {
  await page.goto("/?preset=working&agents=1&stats");
  await expect(placard(page)).toBeVisible();
  await expect
    .poll(async () => (await sceneMetrics(page))?.motion.continuous)
    .toBe(true);
});

test("preview explorer reloads shareable scenes and preserves larger URL rosters", async ({
  page,
}) => {
  const sockets: string[] = [],
    escapedRequests: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:4174")
      escapedRequests.push(request.url());
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/?preset=working&agents=2&theme=dinner&stats");
  const explorer = page.getByRole("complementary", {
      name: "Preview explorer",
    }),
    demoPlacard = placard(page);
  await expect(explorer).toBeVisible();
  await explorer.getByText("Preview explorer", { exact: true }).click();
  await expect(demoPlacard).toContainText(
    "Intentional preview — deterministic mock feed. Nothing here is real.",
  );
  await explorer
    .getByRole("combobox", { name: "Scene" })
    .selectOption("blocked");
  await explorer.getByRole("button", { name: "Load preview" }).click();
  await expect(page).toHaveURL(
    /\?preset=blocked&agents=2&theme=dinner&stats=?$/,
  );
  await expect(
    page.locator('.stationA11yMirror button[aria-label*="Blocked —"]'),
  ).toHaveCount(2);
  await explorer.getByText("Preview explorer", { exact: true }).click();
  await explorer.getByRole("combobox", { name: "Cooks" }).selectOption("0");
  await explorer.getByRole("button", { name: "Load preview" }).click();
  await expect(page).toHaveURL(
    /\?preset=blocked&agents=0&theme=dinner&stats=?$/,
  );
  await expect(page.locator(".stationA11yMirror button")).toHaveCount(0);
  await explorer.getByText("Preview explorer", { exact: true }).click();
  await explorer.getByRole("combobox", { name: "Cooks" }).selectOption("12");
  await explorer.getByRole("combobox", { name: "Scene" }).selectOption("mixed");
  await explorer.getByRole("button", { name: "Load preview" }).click();
  await expect(page).toHaveURL(
    /\?preset=mixed&agents=12&theme=dinner&stats=?$/,
  );
  await explorer.getByText("Preview explorer", { exact: true }).click();
  await expect(explorer.getByRole("combobox", { name: "Scene" })).toHaveValue(
    "mixed",
  );
  await expect(explorer.getByRole("combobox", { name: "Cooks" })).toHaveValue(
    "12",
  );
  await expect(page.locator(".stationA11yMirror button")).toHaveCount(12);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    explorer.getByRole("link", { name: "Install for Herdr" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/funsaized/herdr-mise#quick-start",
  );
  await expect(explorer.getByRole("link", { name: "Source" })).toHaveAttribute(
    "href",
    "https://github.com/funsaized/herdr-mise",
  );
  await expect(
    page.getByRole("button", {
      name: /^Codex, Blocked — .*open details$/,
    }),
  ).toHaveCount(1, { timeout: 7_000 });
  const currentUrl = page.url();
  await Promise.all([
    page.waitForNavigation(),
    explorer.getByRole("button", { name: "Replay" }).click(),
  ]);
  expect(page.url()).toBe(currentUrl);
  await expect(
    page.getByRole("button", {
      name: "Codex, Working — on the fire, open details",
    }),
  ).toHaveCount(1);
  const explorerBox = await explorer.boundingBox(),
    placardBox = await demoPlacard.boundingBox();
  expect(explorerBox).not.toBeNull();
  expect(placardBox).not.toBeNull();
  expect(explorerBox!.x).toBeGreaterThanOrEqual(0);
  expect(explorerBox!.x + explorerBox!.width).toBeLessThanOrEqual(320);
  expect(boxesIntersect(explorerBox!, placardBox!)).toBe(false);
  await page.goto("/?preset=mixed&agents=30");
  await expect(page.locator(".disconnectScrim")).toHaveCount(0);
  await explorer.getByText("Preview explorer", { exact: true }).click();
  await expect(explorer.getByRole("combobox", { name: "Cooks" })).toHaveValue(
    "30",
  );
  await expect(
    explorer.getByRole("option", { name: "30 — URL roster", selected: true }),
  ).toHaveCount(1);
  expect(sockets).toEqual([]);
  expect(escapedRequests).toEqual([]);
});

test("TUI recording controls stay accessible, bounded, and isolated", async ({
  page,
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
  const figureBox = page.getByRole("figure", {
      name: "herdr-mise TUI demo recording",
    }),
    settings = page.getByRole("button", { name: "Open settings" });
  const figure = page.locator(".visualTuiFigure img");
  const description =
      "The herdr-mise terminal runs deterministic demo data, showing its kitchen status before visiting WALK-IN FREEZER.",
    caption = page.getByText(
      "Native Ghostty recording of herdr-mise using deterministic demo data.",
    ),
    stop = page.getByRole("button", { name: "Stop animation" }),
    expand = page.getByRole("button", { name: "Expand recording" });
  await expect(figure).toHaveCount(0);
  await expect(figureBox).toHaveAttribute(
    "aria-describedby",
    "tui-demo-description",
  );
  await expect(page.locator("#tui-demo-description")).toHaveText(description);
  await expect(caption).toBeVisible();
  await expect(stop).toHaveCount(0);
  await expect(expand).toBeVisible();
  const defaultBox = await figureBox.boundingBox();
  expect(defaultBox).not.toBeNull();
  expect(defaultBox!.width).toBeGreaterThanOrEqual(259);
  expect(defaultBox!.width).toBeLessThanOrEqual(261);
  await figureBox.hover();
  await expect
    .poll(async () => (await figureBox.boundingBox())?.width)
    .toBeGreaterThanOrEqual(259);
  const hoverBox = await figureBox.boundingBox(),
    settingsBox = await settings.boundingBox();
  expect(hoverBox).not.toBeNull();
  expect(hoverBox!.width).toBeLessThanOrEqual(261);
  expect(settingsBox).not.toBeNull();
  expect(boxesIntersect(hoverBox!, settingsBox!)).toBe(false);
  await expand.click();
  await expect(figureBox).toHaveAttribute("data-expanded", "true");
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute(
    "alt",
    "The herdr-mise terminal demo moving from the kitchen to the walk-in freezer.",
  );
  await expect(figure).toHaveAttribute("src", "/tui-demo.gif");
  await expect(stop).toBeVisible();
  const mediaBox = await figure.boundingBox(),
    stopBox = await stop.boundingBox(),
    expandBox = await page
      .getByRole("button", { name: "Collapse recording" })
      .boundingBox();
  expect(mediaBox).not.toBeNull();
  expect(stopBox).not.toBeNull();
  expect(expandBox).not.toBeNull();
  expect(boxesIntersect(mediaBox!, stopBox!)).toBe(false);
  expect(boxesIntersect(mediaBox!, expandBox!)).toBe(false);

  await stop.click();
  await expect(figure).toHaveAttribute("src", "/tui-demo-poster.png");
  await expect(figure).toHaveAttribute(
    "alt",
    "Still frame of the herdr-mise terminal demo kitchen.",
  );
  const restart = page.getByRole("button", { name: "Restart animation" });
  await restart.click();
  await expect(figure).toHaveAttribute("src", /\/tui-demo\.gif\?restart=1$/);
  await expect(stop).toBeVisible();
  await page.getByRole("button", { name: "Collapse recording" }).click();
  await expect(figure).toHaveCount(0);
  await expect(stop).toHaveCount(0);

  await page.getByRole("button", { name: "Freezer" }).click();
  await expand.click();
  await expect(figureBox).toHaveAttribute("data-expanded", "true");
  const collapse = page.getByRole("button", { name: "Collapse recording" });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  const expandedBox = await figureBox.boundingBox();
  expect(expandedBox).not.toBeNull();
  expect(expandedBox!.x).toBeGreaterThanOrEqual(0);
  expect(expandedBox!.y).toBeGreaterThanOrEqual(0);
  expect(expandedBox!.x + expandedBox!.width).toBeLessThanOrEqual(1280);
  expect(expandedBox!.y + expandedBox!.height).toBeLessThanOrEqual(720);
  await expect(figure).toHaveCSS("object-fit", "contain");
  const freezer = page.getByRole("button", { name: "Freezer" });
  await freezer.focus();
  await page.keyboard.press("Escape");
  await expect(figureBox).toHaveAttribute("data-expanded", "false");
  await expect(expand).toBeFocused();
  await expect(freezer).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(freezer).toHaveAttribute("aria-pressed", "false");
  await expand.click();
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(figureBox).toHaveAttribute("data-expanded", "false");
  await expect(
    page.getByRole("complementary", { name: "Settings" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await page.mouse.move(400, 500);
  await expect
    .poll(async () => (await figureBox.boundingBox())?.width)
    .toBeLessThanOrEqual(261);

  await page.waitForTimeout(6_500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(placard(page)).toBeVisible();
  expect(sockets).toEqual([]);
  expect(escapedRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("TUI recording respects viewport bounds and serves local assets", async ({
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
  await page.setViewportSize({ width: 901, height: 641 });
  await page.goto("/?preset=working&agents=6");
  await expect(placard(page)).toBeVisible();
  const figureBox = page.getByRole("figure", {
      name: "herdr-mise TUI demo recording",
    }),
    figure = page.locator(".visualTuiFigure img"),
    expand = page.getByRole("button", { name: "Expand recording" }),
    freezer = page.getByRole("button", { name: "Freezer" });
  await expect(figureBox).toBeVisible();
  const boundaryDefaultBox = await figureBox.boundingBox();
  expect(boundaryDefaultBox).not.toBeNull();
  expect(boundaryDefaultBox!.width).toBeGreaterThanOrEqual(199);
  expect(boundaryDefaultBox!.width).toBeLessThanOrEqual(201);
  await figureBox.hover();
  await expect
    .poll(async () => (await figureBox.boundingBox())?.width)
    .toBeLessThanOrEqual(201);
  const boundaryFigureBox = await figureBox.boundingBox(),
    placardBox = await placard(page).boundingBox();
  expect(boundaryFigureBox).not.toBeNull();
  expect(placardBox).not.toBeNull();
  expect(boxesIntersect(boundaryFigureBox!, placardBox!)).toBe(false);
  const kitchen = computeLayout(
    901,
    641,
    Array.from({ length: 6 }, (_, index) => `working-${index}`),
  );
  for (const hit of [kitchen.pass, ...kitchen.stations])
    expect(boxesIntersect(boundaryFigureBox!, hit)).toBe(false);
  await expand.click();
  const boundaryExpandedBox = await figureBox.boundingBox();
  expect(boundaryExpandedBox).not.toBeNull();
  expect(
    boundaryExpandedBox!.x + boundaryExpandedBox!.width,
  ).toBeLessThanOrEqual(901);
  expect(
    boundaryExpandedBox!.y + boundaryExpandedBox!.height,
  ).toBeLessThanOrEqual(641);
  const expandedPlacardBox = await placard(page).boundingBox(),
    expandedControlsBox = await page
      .locator(".visualTuiControls")
      .boundingBox(),
    expandedMediaBox = await figure.boundingBox();
  expect(expandedPlacardBox).not.toBeNull();
  expect(expandedControlsBox).not.toBeNull();
  expect(expandedMediaBox).not.toBeNull();
  expect(boxesIntersect(boundaryExpandedBox!, expandedPlacardBox!)).toBe(false);
  expect(boxesIntersect(expandedMediaBox!, expandedControlsBox!)).toBe(false);
  await page.getByRole("button", { name: "Collapse recording" }).click();

  await freezer.click();
  await expand.click();
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(figureBox).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(freezer).toHaveAttribute("aria-pressed", "false");
  await page.setViewportSize({ width: 1000, height: 640 });
  await expect(figureBox).toBeHidden();
  expect((await request.get("/tui-demo.gif")).status()).toBe(200);
  expect((await request.get("/tui-demo-poster.png")).status()).toBe(200);
  expect((await request.get("/og.png")).status()).toBe(200);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://herdr-mise.s11a.com/og.png",
  );
  const socialAlt =
    "Codex blocked on checkout-api in the herdr-mise DEMO SERVICE kitchen.";
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

test("reduced motion starts stopped and allows an explicit GIF restart", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?preset=blocked&agents=1");
  const figure = page.locator(".visualTuiFigure img");
  await expect(figure).toHaveCount(0);
  await page.getByRole("button", { name: "Expand recording" }).click();
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute(
    "alt",
    "Still frame of the herdr-mise terminal demo kitchen.",
  );
  await expect(figure).toHaveAttribute("src", "/tui-demo-poster.png");
  await page.getByRole("button", { name: "Restart animation" }).click();
  await expect(figure).toHaveAttribute("src", /\/tui-demo\.gif\?restart=1$/);
  await expect(
    page.getByRole("button", { name: "Stop animation" }),
  ).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(figure).toHaveAttribute("src", "/tui-demo-poster.png");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(figure).toHaveAttribute("src", /\/tui-demo\.gif\?restart=1$/);
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
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", {
      name: "mise-02, Working — on the fire, open details",
    }),
  ).toBeFocused();
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
