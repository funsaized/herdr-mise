// Browser acceptance for the visual playground matrix: every preset x
// supported count, the dinner theme URL, invalid-query fallback, storage
// isolation, emitted static fixtures, and liveness beyond the client stale
// timeout. Runs against the visual production build via the webServer config.
import { test, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeLayout,
  reconcileStationSlots,
} from "../client/src/scene/layout";

const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const STATE_WORDS = {
  idle: "Idle — prepping",
  working: "Working — on the fire",
  blocked: "Blocked —",
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
  page: {
    totalCount: number;
    capacity: number;
    pageIndex: number;
    pageCount: number;
    visibleIds: string[];
  };
  stateIndicators: Record<string, number>;
  endedEntries: number;
  stationVisuals: Record<
    string,
    { accent: string; idlePose: string | null; prepStep: 0 | 1 | null }
  >;
  spiritAccents: Record<string, string>;
  spiritPoseBounds: Record<string, Pick<Box, "width" | "height">>;
  stationCells: Record<string, Box>;
  stationNameBounds: Record<string, Box & { text: string }>;
  stationStatusBounds: Record<string, Box & { text: string }>;
  activeFocusBounds: Record<string, Box>;
  activeFocusCornerSizes: Record<string, number>;
  blockedPlacements: Record<
    string,
    {
      id: string;
      kind: "pass" | "station";
      queueOrdinal: number;
      queueTotal: number;
      cookBounds: Box;
      ticket: Box;
      timer: Box;
      station: Box;
      bell: Box;
      timerText: string;
      exiting: boolean;
    }
  >;
  view: "kitchen" | "freezer";
  visibleSpirits: number;
  board: {
    headers: string[];
    rows: { id: string; text: string[] }[];
    strokedIds: string[];
  };
  atmosphere: {
    window: number;
    shelf: number;
    pass: number;
    workingContact: number;
    freezerAccents: number;
  };
  materials: {
    wallPlanes: number;
    floorSeams: number;
    fixtureShadows: number;
    passEdges: number;
    stationGroundings: number;
  };
};
type Box = { x: number; y: number; width: number; height: number };
const sceneMetrics = (page: Page) =>
  page.evaluate(() =>
    (
      window as typeof window & { __miseSceneMetrics?: () => MotionMetrics }
    ).__miseSceneMetrics?.(),
  );

const placard = (page: Page) =>
  page.getByRole("status").filter({ hasText: "DEMO SERVICE" });

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("failed to reserve a browser fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function boxesIntersect(first: Box, second: Box) {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

const FULL_STATUSES = new Set([
  "PREP",
  "FIRE",
  "AT THE PASS",
  "BLOCKED AT STATION",
  "PLATED",
  "86'D",
  "WORK RESUMED",
  "UNKNOWN · PREP",
]);

function expectInside(inner: Box, outer: Box, tolerance = 3) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - tolerance);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - tolerance);
  expect(inner.x + inner.width).toBeLessThanOrEqual(
    outer.x + outer.width + tolerance,
  );
  expect(inner.y + inner.height).toBeLessThanOrEqual(
    outer.y + outer.height + tolerance,
  );
}

async function cycleSceneFocus(page: Page, count: number) {
  const stationIds = new Set<string>(),
    boardIds = new Set<string>();
  for (let index = 0; index < count; index++) {
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => {
        const metrics = await sceneMetrics(page);
        return (
          Object.keys(metrics?.activeFocusBounds ?? {}).length +
          (metrics?.board.strokedIds.length ?? 0)
        );
      })
      .toBe(1);
    const focused = (await sceneMetrics(page))!,
      [stationId] = Object.keys(focused.activeFocusBounds),
      [boardId] = focused.board.strokedIds;
    if (stationId) {
      stationIds.add(stationId);
      expectInside(
        focused.activeFocusBounds[stationId]!,
        focused.stationCells[stationId]!,
      );
    } else if (boardId) boardIds.add(boardId);
  }
  return { stationIds, boardIds };
}

async function assertResponsiveScene(page: Page, count: number, demo: boolean) {
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(async () => {
      const metrics = await sceneMetrics(page),
        cells = Object.values(metrics?.stationCells ?? {}),
        viewport = page.viewportSize()!;
      return (
        metrics?.page.totalCount === count &&
        cells.length === metrics.page.visibleIds.length &&
        cells.every(
          (cell) =>
            cell.x >= 0 &&
            cell.y >= 0 &&
            cell.x + cell.width <= viewport.width &&
            cell.y + cell.height <= viewport.height,
        )
      );
    })
    .toBe(true);
  const metrics = (await sceneMetrics(page))!,
    viewport = {
      x: 0,
      y: 0,
      width: page.viewportSize()!.width,
      height: page.viewportSize()!.height,
    },
    text = Object.entries(metrics.stationNameBounds).flatMap(([id, bounds]) => [
      { id, bounds },
      { id, bounds: metrics.stationStatusBounds[id]! },
    ]);
  for (const [id, cell] of Object.entries(metrics.stationCells)) {
    expectInside(cell, viewport);
    expectInside(metrics.stationNameBounds[id]!, cell);
    expectInside(metrics.stationStatusBounds[id]!, cell);
    expect(
      [...FULL_STATUSES].some((status) =>
        metrics.stationStatusBounds[id]!.text.startsWith(status),
      ),
    ).toBe(true);
  }
  for (const [index, first] of text.entries())
    for (const second of text.slice(index + 1))
      if (first.id !== second.id)
        expect(boxesIntersect(first.bounds, second.bounds)).toBe(false);

  const settings = page.getByRole("button", { name: "Open settings" }),
    freezer = page.getByRole("button", { name: "Freezer" });
  await expect(settings).toBeVisible();
  await expect(freezer).toBeVisible();
  if (demo) {
    const banner = placard(page);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("DEMO SERVICE");
    await expect(banner).toContainText("Nothing here is real.");
    const bannerBox = (await banner.boundingBox())!;
    expectInside(bannerBox, viewport);
    expect(boxesIntersect(bannerBox, (await settings.boundingBox())!)).toBe(
      false,
    );
    expect(boxesIntersect(bannerBox, (await freezer.boundingBox())!)).toBe(
      false,
    );
    if (viewport.width <= 480)
      await expect(banner.locator("small")).toBeHidden();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await cycleSceneFocus(page, metrics.page.visibleIds.length);
  await page.keyboard.press("Enter");
  await expect(
    page.locator(
      'aside[aria-label$="details"], aside[aria-label$="session summary"]',
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[aria-label="Agent stations"] button:focus'),
  ).toHaveCount(1);
  await expect
    .poll(async () => {
      const metrics = await sceneMetrics(page);
      return (
        Object.keys(metrics?.activeFocusBounds ?? {}).length +
        (metrics?.board.strokedIds.length ?? 0)
      );
    })
    .toBe(1);
}

function boardRowPoint(width: number, height: number) {
  const layout = computeLayout(width, height, []),
    boardWidth = Math.min(layout.unit * 92, layout.wall.width * 0.36);
  return {
    x: (layout.wall.width - boardWidth) / 2 + layout.unit * 3 + 16,
    y: layout.unit * (4 + 12) + 4,
  };
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
    "Freezer, 12 of 12 ended chefs shown",
  );
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(
    page.locator('aside[aria-label$="session summary"]'),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('aside[aria-label$="session summary"]'),
  ).toHaveCount(0);
  await expect(freezer).toHaveAttribute("aria-pressed", "true");
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

test("workspace scope follows stable identity without hiding blocked attention", async ({
  page,
}) => {
  const directory = await mkdtemp(
      join(tmpdir(), "herdr-mise-workspace-scope-"),
    ),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    initial = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-workspace-scope.json",
        ),
        "utf8",
      ),
    ),
    sockets = new Set<Socket>();
  let snapshot = JSON.stringify({ result: { snapshot: initial } });
  const fixtureServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\n")) return;
      const method = JSON.parse(request).method;
      if (method === "session.snapshot") socket.end(`${snapshot}\n`);
      else socket.write('{"result":{"type":"subscription_started"}}\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(socketPath, resolve);
  });
  const app = spawn("target/debug/herdr-mise", [], {
    env: {
      ...process.env,
      HERDR_MISE_PORT: String(port),
      HERDR_SOCKET_PATH: socketPath,
    },
    stdio: "ignore",
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(appUrl)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`${appUrl}/?stats`);
    const selector = page.getByRole("combobox", { name: "Workspace" });
    await expect(selector).toHaveValue("");
    await expect(page.getByRole("option")).toHaveText([
      "All",
      "empty",
      "duplicate (aceone)",
      "duplicate (acetwo)",
    ]);
    await expect(
      page.getByRole("button", { name: /scope-working, Working/ }),
    ).toBeAttached();
    await expect(
      page.getByRole("button", { name: /scope-blocked, Blocked/ }),
    ).toBeAttached();
    await expect
      .poll(async () =>
        Object.keys((await sceneMetrics(page))?.stationCells ?? {}),
      )
      .toEqual(["scope-terminal-one"]);

    await selector.selectOption("scope-workspace-one");
    await expect(
      page.getByRole("button", { name: /scope-blocked, Blocked/ }),
    ).toHaveCount(0);
    await expect
      .poll(async () => {
        const metrics = await sceneMetrics(page);
        return [
          Object.keys(metrics?.stationCells ?? {}),
          metrics?.escalationBlockedAgents,
        ];
      })
      .toEqual([["scope-terminal-one"], 1]);
    const showAll = page.getByRole("button", {
      name: "1 blocked elsewhere — Show all",
    });
    const selectorBox = (await selector.boundingBox())!,
      showAllBox = (await showAll.boundingBox())!;
    expect(selectorBox.height).toBeGreaterThanOrEqual(44);
    expect(showAllBox.height).toBeGreaterThanOrEqual(44);
    await selector.focus();
    await page.keyboard.press("Tab");
    await expect(showAll).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(selector).toBeFocused();
    await expect(selector).toHaveValue("");
    await expect(
      page.getByRole("button", { name: /scope-blocked, Blocked/ }),
    ).toBeAttached();

    await selector.selectOption("scope-workspace-one");
    const renamed = structuredClone(initial);
    renamed.workspaces[0].label = "renamed";
    snapshot = JSON.stringify({ result: { snapshot: renamed } });
    await expect(selector).toHaveValue("scope-workspace-one");
    await expect(page.getByRole("option", { name: "renamed" })).toBeAttached({
      timeout: 10_000,
    });

    const removed = structuredClone(renamed);
    removed.workspaces = [
      removed.workspaces[1],
      removed.workspaces[2],
      { workspace_id: "scope-workspace-new", label: "renamed" },
    ];
    removed.agents = [
      removed.agents[1],
      {
        terminal_id: "scope-terminal-new",
        pane_id: "scope-pane-new",
        workspace_id: "scope-workspace-new",
        display_agent: "scope-new",
        agent_status: "working",
      },
    ];
    snapshot = JSON.stringify({ result: { snapshot: removed } });
    await expect(selector).toHaveValue("scope-workspace-one", {
      timeout: 10_000,
    });
    const unavailable = page
      .getByRole("status")
      .filter({ hasText: "renamed is unavailable" });
    await expect(unavailable).toBeVisible();
    await expect(
      page.getByRole("button", { name: /scope-new, Working/ }),
    ).toHaveCount(0);
    await expect(showAll).toBeVisible();
    const scopeBox = await page.locator(".workspaceScope").boundingBox(),
      unavailableBox = await unavailable.boundingBox();
    expect(scopeBox).not.toBeNull();
    expect(unavailableBox).not.toBeNull();
    expectInside(scopeBox!, { x: 0, y: 0, width: 320, height: 640 });
    expectInside(unavailableBox!, { x: 0, y: 0, width: 320, height: 640 });
    expect(boxesIntersect(scopeBox!, unavailableBox!)).toBe(false);
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoritative fixture state sequence drives history accents poses prep and freezer spirits", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-freezer-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    baseline = JSON.stringify(
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "server/tests/fixtures/snapshot-herdr-0.8.2-p20.json",
          ),
          "utf8",
        ),
      ),
    ),
    advanced = JSON.stringify(
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "server/tests/fixtures/snapshot-herdr-0.8.2-p20-state-sequence-advanced.json",
          ),
          "utf8",
        ),
      ),
    ),
    working = JSON.stringify(
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "server/tests/fixtures/snapshot-working-idle-accents.json",
          ),
          "utf8",
        ),
      ),
    ),
    blocked = JSON.stringify({
      result: {
        snapshot: JSON.parse(
          await readFile(
            join(
              process.cwd(),
              "server/tests/fixtures/snapshot-herdr-0.8.0-p19.json",
            ),
            "utf8",
          ),
        ),
      },
    }),
    empty = JSON.stringify(
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "server/tests/fixtures/snapshot-protocol-19-empty-agents.json",
          ),
          "utf8",
        ),
      ),
    ),
    sockets = new Set<Socket>(),
    escapedRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== appUrl)
      escapedRequests.push(request.url());
  });
  let snapshot = baseline;
  const fixtureServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\n")) return;
      const method = JSON.parse(request).method;
      if (method === "session.snapshot") socket.end(`${snapshot.trim()}\n`);
      else socket.write('{"result":{"type":"subscription_started"}}\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(socketPath, resolve);
  });
  const app = spawn("target/debug/herdr-mise", [], {
    env: {
      ...process.env,
      HERDR_MISE_PORT: String(port),
      HERDR_SOCKET_PATH: socketPath,
    },
    stdio: "ignore",
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(appUrl)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await page.goto(`${appUrl}/?stats`);
    await expect(
      page.getByRole("complementary", { name: "Preview explorer" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /Install for Herdr|Source/ }),
    ).toHaveCount(0);
    expect(escapedRequests).toEqual([]);
    const sequenceStation = page.getByRole("button", {
      name: "example-cook, Working — on the fire, open details",
    });
    await expect(sequenceStation).toBeAttached();
    await sequenceStation.evaluate((element) =>
      (element as HTMLButtonElement).click(),
    );
    const sequenceDetails = page.getByRole("complementary", {
        name: "example-cook details",
      }),
      stateAge = sequenceDetails
        .locator(".fact", { hasText: "Observation age" })
        .locator("b"),
      periods = sequenceDetails.getByRole("list", {
        name: "Mise observation history",
      });
    await expect.poll(() => stateAge.textContent()).toMatch(/^[2-9]\d*s$/);
    await expect(periods.getByRole("listitem")).toHaveCount(1);
    snapshot = advanced;
    await expect(periods.getByRole("listitem")).toHaveCount(2);
    await expect(
      periods.getByRole("listitem", { name: /Working — on the fire period/ }),
    ).toHaveCount(2);
    await expect(
      periods.getByRole("listitem", { name: /Blocked/ }),
    ).toHaveCount(0);
    await expect(stateAge).toHaveText("0s");
    expect(
      await periods.evaluate((element) => getComputedStyle(element).columnGap),
    ).toBe("2px");
    await page.getByRole("button", { name: "Close panel" }).click();
    snapshot = working;
    await expect(
      page.getByRole("button", {
        name: "fixture-working, Working — on the fire, open details",
      }),
    ).toBeAttached();
    await expect(
      page.getByRole("button", {
        name: "fixture-idle, Idle — prepping, open details",
      }),
    ).toBeAttached();
    await expect
      .poll(async () => (await sceneMetrics(page))?.stationVisuals["t-11"])
      .toMatchObject({ accent: "#6f8a9a", idlePose: null });
    await expect
      .poll(async () => (await sceneMetrics(page))?.motion.activeParticles)
      .toBeGreaterThan(0);
    expect((await sceneMetrics(page))?.atmosphere.workingContact).toBe(1);
    expect(
      (await sceneMetrics(page))?.motion.activeParticles,
    ).toBeLessThanOrEqual(48);
    const workingTruth = await sceneMetrics(page);
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
        motion: { activeParticles: 0 },
      });
    const atmosphereOff = await sceneMetrics(page);
    expect(atmosphereOff?.stationCells).toEqual(workingTruth?.stationCells);
    expect(atmosphereOff?.stationNameBounds).toEqual(
      workingTruth?.stationNameBounds,
    );
    expect(atmosphereOff?.stationStatusBounds).toEqual(
      workingTruth?.stationStatusBounds,
    );
    expect(atmosphereOff?.stateIndicators).toEqual(
      workingTruth?.stateIndicators,
    );
    expect(atmosphereOff?.board).toEqual(workingTruth?.board);
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => (await sceneMetrics(page))?.motion.activeParticles)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await sceneMetrics(page))?.stationVisuals["t-8"])
      .toMatchObject({ accent: "#a98a5b", prepStep: null });
    expect(
      (await sceneMetrics(page))?.stationVisuals["t-8"]?.idlePose,
    ).not.toMatch(/prep|smoke/i);
    const firstPrepStep = (await sceneMetrics(page))?.stationVisuals["t-11"]
      ?.prepStep;
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.stationVisuals["t-11"]?.prepStep !==
          firstPrepStep,
      )
      .toBe(true);
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await assertResponsiveScene(page, 2, false);
    }
    snapshot = blocked;
    await page.setViewportSize({ width: 390, height: 844 });
    const blockedStation = page.getByRole("button", {
      name: /example-reviewer, Blocked — at the pass.*open details/,
    });
    await expect(blockedStation).toBeAttached({ timeout: 10_000 });
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        stateIndicators: { blocked: 1 },
        atmosphere: { workingContact: 0 },
        motion: { activeParticles: 0 },
        stationVisuals: {
          "fictional-terminal-19": {
            accent: "#7a7f9e",
            idlePose: null,
            prepStep: null,
          },
        },
      });
    await page.locator(".canvasHost").evaluate((element) => {
      element.setAttribute("tabindex", "-1");
      (element as HTMLElement).focus();
    });
    await expect
      .poll(async () => {
        if (
          await blockedStation.evaluate((element) => element.matches(":focus"))
        )
          return true;
        await page.keyboard.press("ArrowRight");
        return blockedStation.evaluate((element) => element.matches(":focus"));
      })
      .toBe(true);
    await expect(blockedStation).toBeFocused();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveAttribute(
      "id",
      "station-tooltip-fictional-terminal-19",
    );
    await expect(blockedStation).toHaveAttribute(
      "aria-describedby",
      "station-tooltip-fictional-terminal-19",
    );
    const tooltipBox = await tooltip.boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press("Enter");
    const details = page.getByRole("complementary", {
        name: "example-reviewer details",
      }),
      primaryPanels = page.locator("aside.panel");
    await expect(details).toBeFocused();
    await expect(
      details.locator(".fact", { hasText: "Workspace" }).locator("b"),
    ).toHaveText("example-pantry");
    await expect(primaryPanels).toHaveCount(1);
    await expect(tooltip).toHaveCount(0);
    const selected = (await sceneMetrics(page))!.activeFocusBounds[
        "fictional-terminal-19"
      ]!,
      detailBox = await details.boundingBox();
    expect(
      (await sceneMetrics(page))!.activeFocusCornerSizes[
        "fictional-terminal-19"
      ],
    ).toBe(13.5);
    expect(detailBox).not.toBeNull();
    expectInside(detailBox!, { x: 0, y: 0, width: 390, height: 844 });
    expect(boxesIntersect(selected, detailBox!)).toBe(false);
    const settings = page.getByRole("button", { name: "Open settings" });
    await settings.focus();
    await page.keyboard.press("Enter");
    const settingsPanel = page.getByRole("complementary", { name: "Settings" });
    await expect(settingsPanel).toBeFocused();
    await expect(primaryPanels).toHaveCount(1);
    await expect(details).toHaveCount(0);
    const settingsBox = await settingsPanel.boundingBox();
    expect(settingsBox).not.toBeNull();
    expectInside(settingsBox!, { x: 0, y: 0, width: 390, height: 844 });
    expect(boxesIntersect(selected, settingsBox!)).toBe(false);
    await page.setViewportSize({ width: 320, height: 640 });
    const narrowSelected = (await sceneMetrics(page))!.activeFocusBounds[
        "fictional-terminal-19"
      ]!,
      narrowSettingsBox = await settingsPanel.boundingBox();
    expect(narrowSettingsBox).not.toBeNull();
    expectInside(narrowSettingsBox!, { x: 0, y: 0, width: 320, height: 640 });
    expect(boxesIntersect(narrowSelected, narrowSettingsBox!)).toBe(false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    await expect(details).toBeVisible();
    await expect(primaryPanels).toHaveCount(1);
    const narrowDetailBox = await details.boundingBox();
    expect(narrowDetailBox).not.toBeNull();
    expect(boxesIntersect(narrowSelected, narrowDetailBox!)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(blockedStation).toBeFocused();
    await expect(primaryPanels).toHaveCount(0);
    await page.mouse.click(
      narrowSelected.x + narrowSelected.width / 2,
      narrowSelected.y + narrowSelected.height / 2,
    );
    await expect(details).toBeVisible();
    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(blockedStation).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    snapshot = empty;
    await expect(
      page.getByRole("button", {
        name: "fixture-working, Working — on the fire, open details",
      }),
    ).toHaveCount(0);
    const boardButton = page
      .getByRole("navigation", { name: "Agent stations" })
      .getByRole("button", { name: /fixture-working, Ended/i });
    await expect(boardButton).toBeAttached();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        endedEntries: 4,
        atmosphere: { workingContact: 0 },
        motion: { activeParticles: 0 },
        board: {
          headers: ["COOK", "MISE TIME"],
          rows: [{}, {}, {}],
        },
      });
    const rows = (await sceneMetrics(page))?.board.rows
      .map((row) => row.text)
      .sort(([left], [right]) => left!.localeCompare(right!));
    expect(rows?.map(([name]) => name)).toEqual([
      "EXAMPLE-REVIEWER",
      "FIXTURE-IDLE",
      "FIXTURE-WORKING",
    ]);
    for (const [, runtime] of rows ?? [])
      expect(runtime).toMatch(/^(?:—|\d+:\d{2})$/);
    await settings.click();
    const emptyStatus = page
      .getByRole("status")
      .filter({ hasText: "Waiting for agents" });
    await expect(settingsPanel).toBeVisible();
    await expect(emptyStatus).toBeVisible();
    const emptySettingsBox = await settingsPanel.boundingBox(),
      emptyStatusBox = await emptyStatus.boundingBox();
    expect(emptySettingsBox).not.toBeNull();
    expect(emptyStatusBox).not.toBeNull();
    expect(boxesIntersect(emptySettingsBox!, emptyStatusBox!)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    await boardButton.evaluate((element) =>
      (element as HTMLButtonElement).click(),
    );
    await expect(
      page.locator('aside[aria-label$="session summary" i]'),
    ).toBeVisible();
    await expect(primaryPanels).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Freezer" }).click();
    await expect(page.getByRole("button", { name: "Freezer" })).toHaveCSS(
      "background-color",
      "rgb(44, 39, 33)",
    );
    await expect(
      page.getByRole("navigation", { name: "Ended chefs" }).getByRole("button"),
    ).toHaveCount(4);
    await expect(page.getByLabel("Agent state announcements")).toHaveText(
      "Freezer, 4 of 4 ended chefs shown",
    );
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        view: "freezer",
        endedEntries: 4,
        visibleSpirits: 4,
        atmosphere: { freezerAccents: 11 },
        motion: { activeParticles: 0 },
      });
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await expect
      .poll(async () => (await sceneMetrics(page))?.atmosphere)
      .toEqual({
        window: 0,
        shelf: 0,
        pass: 0,
        workingContact: 0,
        freezerAccents: 0,
      });
    expect(escapedRequests).toEqual([]);
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("real fixture service summary cycles every blocked cook without moving stations", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-summary-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    source = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-herdr-0.8.0-p19.json",
        ),
        "utf8",
      ),
    ),
    sockets = new Set<Socket>();
  let snapshot = "";
  const setRoster = (count: number, allBlocked = false) => {
      const states = allBlocked
        ? ["blocked"]
        : ["blocked", "working", "idle", "done"];
      snapshot = JSON.stringify({
        result: {
          snapshot: {
            ...source,
            agents: Array.from({ length: count }, (_, index) => ({
              ...source.agents[0],
              terminal_id: `fixture-terminal-${String(index).padStart(2, "0")}`,
              pane_id: `fixture-${String(index).padStart(2, "0")}`,
              display_agent: `Cook${String(index).padStart(2, "0")}`,
              agent_status: states[index % states.length],
              agent_session: { value: `fixture-session-${index}` },
            })),
          },
        },
      });
    },
    fixtureServer = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let request = "";
      socket.on("data", (chunk) => {
        request += chunk;
        if (!request.includes("\n")) return;
        const method = JSON.parse(request).method;
        if (method === "session.snapshot") socket.end(`${snapshot}\n`);
        else socket.write('{"result":{"type":"subscription_started"}}\n');
      });
    });
  setRoster(4);
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(socketPath, resolve);
  });
  const app = spawn("target/debug/herdr-mise", [], {
    env: {
      ...process.env,
      HERDR_MISE_PORT: String(port),
      HERDR_SOCKET_PATH: socketPath,
    },
    stdio: "ignore",
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(appUrl)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`${appUrl}/?stats`);
    for (const count of [4, 16, 30]) {
      setRoster(count);
      const blockedCount = Math.ceil(count / 4),
        summary = page.getByRole("region", {
          name: "Observed service summary",
        });
      await expect(summary).toContainText(`Blocked: ${blockedCount}`, {
        timeout: 10_000,
      });
      await expect(summary).toContainText(`Shown: ${count} of ${count}`);
      await expect(summary).toContainText("Hidden plated: 0");
      await expect(summary).toContainText("Oldest blocked: Cook00");
      expect(await summary.locator("strong").allTextContents()).toEqual([
        "Observed -",
        "Working:",
        "Blocked:",
        "Plated:",
        "Unknown:",
        "Shown:",
        "Hidden plated:",
        "Oldest blocked:",
      ]);
      const initialMetrics = (await sceneMetrics(page))!;
      const summaryBox = (await summary.boundingBox())!,
        canvasBox = (await page.locator(".canvasHost").boundingBox())!;
      expect(canvasBox).toEqual({ x: 0, y: 0, width: 320, height: 640 });
      expect(
        Object.values(initialMetrics.stationStatusBounds).filter((status) =>
          boxesIntersect(summaryBox, status),
        ),
        `summary ${JSON.stringify(summaryBox)}; canvas ${JSON.stringify(canvasBox)}`,
      ).toEqual([]);
      expect(
        Object.keys(initialMetrics.blockedPlacements).length,
      ).toBeGreaterThan(0);
      expect(
        Object.keys(initialMetrics.blockedPlacements).length,
      ).toBeLessThanOrEqual(blockedCount);
      const stationBounds = Object.values(initialMetrics.stationCells),
        focused = new Set<string>();
      let firstFocused = "";
      for (let index = 0; index <= blockedCount; index++) {
        await page.keyboard.press("b");
        await expect
          .poll(async () =>
            Object.keys((await sceneMetrics(page))!.activeFocusBounds),
          )
          .toHaveLength(1);
        const focusedId = Object.keys(
          (await sceneMetrics(page))!.activeFocusBounds,
        )[0]!;
        if (index === 0) firstFocused = focusedId;
        else if (index === blockedCount) expect(focusedId).toBe(firstFocused);
        focused.add(focusedId);
      }
      expect(focused.size).toBe(blockedCount);
      expect(Object.values((await sceneMetrics(page))!.stationCells)).toEqual(
        stationBounds,
      );
    }
    setRoster(12, true);
    const summary = page.getByRole("region", {
      name: "Observed service summary",
    });
    await expect(summary).toContainText("Blocked: 12", { timeout: 10_000 });
    await expect
      .poll(
        async () =>
          Object.keys((await sceneMetrics(page))!.blockedPlacements).length,
      )
      .toBeGreaterThan(0);
    const summaryBox = (await summary.boundingBox())!,
      statusBounds = Object.values(
        (await sceneMetrics(page))!.stationStatusBounds,
      );
    expect(
      statusBounds.filter((status) => boxesIntersect(summaryBox, status)),
    ).toEqual([]);
    await page.getByRole("button", { name: "Freezer" }).click();
    await expect(
      page.getByRole("button", { name: /Next blocked:/ }),
    ).toBeDisabled();
    await page.keyboard.press("b");
    await expect
      .poll(async () => (await sceneMetrics(page))?.view)
      .toBe("freezer");
    await expect
      .poll(async () =>
        Object.keys((await sceneMetrics(page))!.activeFocusBounds),
      )
      .toHaveLength(0);
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture-backed duplicate identity inspection", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-identity-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    kindFixture = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-working-idle-accents.json",
        ),
        "utf8",
      ),
    ),
    source = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-herdr-0.8.0-p19.json",
        ),
        "utf8",
      ),
    );
  source.workspaces = [
    {
      workspace_id: "one",
      label: "/work/料理/very-long-shared-workspace",
    },
    { workspace_id: "two", label: "/other/very-long-shared-workspace" },
  ];
  const locatorOne = "pane-with-a-very-long-shared-prefix-🥘-one",
    locatorTwo = "pane-with-a-very-long-shared-prefix-🥘-two";
  source.agents[0] = {
    ...source.agents[0],
    terminal_id: "terminal-one",
    pane_id: locatorOne,
    workspace_id: "one",
    name: "same chef",
    agent: kindFixture.result.snapshot.agents[0].agent,
  };
  source.agents.push({
    ...source.agents[0],
    terminal_id: "terminal-two",
    pane_id: locatorTwo,
    workspace_id: "two",
  });
  let snapshot = JSON.stringify({ result: { snapshot: source } });
  const sockets = new Set<Socket>(),
    fixtureServer = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let request = "";
      socket.on("data", (chunk) => {
        request += chunk;
        if (!request.includes("\n")) return;
        const method = JSON.parse(request).method;
        if (method === "session.snapshot") socket.end(`${snapshot}\n`);
        else socket.write('{"result":{"type":"subscription_started"}}\n');
      });
    });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(socketPath, resolve);
  });
  const app = spawn("target/debug/herdr-mise", [], {
    env: {
      ...process.env,
      HERDR_MISE_PORT: String(port),
      HERDR_SOCKET_PATH: socketPath,
    },
    stdio: "ignore",
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(appUrl)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: appUrl,
    });
    await page.setViewportSize({ width: 420, height: 640 });
    await page.goto(`${appUrl}/?stats`);
    const first = page.getByRole("button", {
      name: /same chef .*one, Blocked/,
    });
    await expect(first).toBeAttached();
    await expect(
      page.getByRole("button", {
        name: /same chef .*two, Blocked/,
      }),
    ).toBeAttached();
    await assertResponsiveScene(page, 2, false);
    const labels = Object.values((await sceneMetrics(page))!.stationNameBounds);
    expect(labels.every(({ text }) => Array.from(text).length <= 30)).toBe(
      true,
    );
    expect(labels.map(({ text }) => text.slice(-3)).sort()).toEqual([
      "one",
      "two",
    ]);
    await first.evaluate((button: HTMLButtonElement) => button.click());
    const details = page.getByLabel("same chef details");
    await expect(details).toContainText("very-long-shared-workspace");
    await expect(details).toContainText("codex");
    await expect(details).toContainText(locatorOne);
    const copyLocator = details.getByRole("button", { name: "Copy locator" });
    await expect(copyLocator).toHaveCSS("min-width", "44px");
    await expect(copyLocator).toHaveCSS("min-height", "44px");
    await copyLocator.click();
    await expect(details).toContainText("Locator copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      locatorOne,
    );

    const movedLocator = "pane-with-a-very-long-shared-prefix-🥘-moved";
    source.agents[0].pane_id = movedLocator;
    snapshot = JSON.stringify({ result: { snapshot: source } });
    await expect(details).toContainText(movedLocator, { timeout: 5_000 });
    await expect(details).toContainText("very-long-shared-workspace");

    source.agents = [];
    snapshot = JSON.stringify({ result: { snapshot: source } });
    await page.getByRole("button", { name: "Freezer" }).click();
    const ended = page.getByRole("navigation", { name: "Ended chefs" });
    await expect(
      ended.getByRole("button", {
        name: /same chef · Unavailable · terminal-one, Ended/,
      }),
    ).toBeAttached({ timeout: 5_000 });
    await expect(
      ended.getByRole("button", {
        name: /same chef · Unavailable · terminal-two, Ended/,
      }),
    ).toBeAttached();
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoritative fixture keeps live kitchen after done-timeout dismissal and reveal", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-done-clear-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    source = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-herdr-0.8.2-p20.json",
        ),
        "utf8",
      ),
    ) as {
      agents: Array<{
        terminal_id: string;
        pane_id: string;
        workspace_id: string;
        display_agent: string;
        agent_status: string;
        agent_session: { value: string };
      }>;
    },
    empty = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-protocol-19-empty-agents.json",
        ),
        "utf8",
      ),
    ),
    makeSnapshot = () => ({
      ...source,
      agents: Array.from({ length: 12 }, (_, index) => {
        const suffix = String(index + 1).padStart(2, "0");
        return {
          ...source.agents[0]!,
          terminal_id: `fictional-terminal-${suffix}`,
          pane_id: `fictional-pane-${suffix}`,
          display_agent: `example-cook-${suffix}`,
          agent_status: "working",
          agent_session: { value: `fictional-session-${suffix}` },
        };
      }),
    }),
    sockets = new Set<Socket>(),
    stations = page
      .getByRole("navigation", { name: "Agent stations" })
      .getByRole("button"),
    doneCook = page.getByRole("button", {
      name: /example-cook-01, Done — plated/,
    }),
    workingCook = page.getByRole("button", {
      name: /example-cook-01, Working — on the fire/,
    }),
    reveal = page.getByRole("button", {
      name: "1 plated cook cleared — reveal",
    }),
    emptyStatus = page
      .getByRole("status")
      .filter({ hasText: "Waiting for agents" }),
    announcements = page.getByLabel("Agent state announcements");
  let snapshot: object = makeSnapshot();
  const fixtureServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\n")) return;
      const method = JSON.parse(request).method;
      if (method === "session.snapshot")
        socket.end(`${JSON.stringify({ result: { snapshot } })}\n`);
      else socket.write('{"result":{"type":"subscription_started"}}\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(socketPath, resolve);
  });
  const app = spawn("target/debug/herdr-mise", [], {
    env: {
      ...process.env,
      HERDR_MISE_PORT: String(port),
      HERDR_SOCKET_PATH: socketPath,
    },
    stdio: "ignore",
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(appUrl)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await page.addInitScript(() => {
      const nativeSetTimeout = window.setTimeout.bind(window),
        nativeClearTimeout = window.clearTimeout.bind(window),
        pending = new Map();
      let nextId = 1e9;
      window.setTimeout = (handler, timeout, ...args) => {
        if (timeout === 600000 && typeof handler === "function") {
          const id = nextId++;
          pending.set(id, () => {
            pending.delete(id);
            handler(...args);
          });
          return id;
        }
        return nativeSetTimeout(handler, timeout, ...args);
      };
      window.clearTimeout = (id) => {
        if (pending.delete(id)) return;
        nativeClearTimeout(id);
      };
      Object.defineProperty(window, "__miseFlushDoneTimeouts", {
        configurable: true,
        value: () => {
          for (const run of [...pending.values()]) run();
        },
      });
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${appUrl}/?stats`);
    await expect(stations).toHaveCount(12, { timeout: 10_000 });
    await expect(workingCook).toBeAttached();
    snapshot = structuredClone(snapshot);
    (
      snapshot as { agents: Array<{ agent_status: string }> }
    ).agents[0]!.agent_status = "done";
    await expect(doneCook).toBeAttached({ timeout: 10_000 });
    await page.evaluate(() =>
      (
        window as typeof window & { __miseFlushDoneTimeouts?: () => void }
      ).__miseFlushDoneTimeouts?.(),
    );
    await expect(reveal).toBeVisible();
    await expect(emptyStatus).toHaveCount(0);
    await expect(stations).toHaveCount(11);
    await expect(doneCook).toHaveCount(0);
    await expect(announcements).toHaveText(
      "example-cook-01 cleared from the kitchen",
    );
    snapshot = structuredClone(snapshot);
    await page.waitForTimeout(1_500);
    await expect(reveal).toBeVisible();
    await expect(stations).toHaveCount(11);
    await expect(doneCook).toHaveCount(0);
    await expect(emptyStatus).toHaveCount(0);
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
      { width: 320, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(async () => {
          const metrics = await sceneMetrics(page),
            cells = Object.values(metrics?.stationCells ?? {});
          return (
            metrics?.page.totalCount === 11 &&
            cells.length === metrics.page.visibleIds.length &&
            cells.every((cell) => cell.width > 0)
          );
        })
        .toBe(true);
      const revealBox = (await reveal.boundingBox())!,
        workspaceBox = (await page.locator(".workspaceScope").boundingBox())!,
        pager = page.locator(".kitchenPager"),
        pagerBox = (await pager.count()) ? await pager.boundingBox() : null,
        settingsBox = (await page
          .getByRole("button", { name: "Open settings" })
          .boundingBox())!,
        freezerBox = (await page
          .getByRole("button", { name: "Freezer" })
          .boundingBox())!;
      expect(boxesIntersect(revealBox, workspaceBox)).toBe(false);
      if (pagerBox) expect(boxesIntersect(revealBox, pagerBox)).toBe(false);
      expect(boxesIntersect(revealBox, settingsBox)).toBe(false);
      expect(boxesIntersect(revealBox, freezerBox)).toBe(false);
      for (const cell of Object.values(
        (await sceneMetrics(page))!.stationCells,
      ))
        expect(boxesIntersect(revealBox, cell)).toBe(false);
    }
    await reveal.click();
    await expect(announcements).toHaveText("1 plated cook revealed");
    await expect(doneCook).toBeVisible();
    await expect(reveal).toHaveCount(0);
    snapshot = structuredClone(snapshot);
    (
      snapshot as { agents: Array<{ agent_status: string }> }
    ).agents[0]!.agent_status = "working";
    await expect(workingCook).toBeAttached({ timeout: 10_000 });
    await page.reload();
    await expect(stations).toHaveCount(12, { timeout: 10_000 });
    await expect(workingCook).toBeVisible();
    snapshot = empty;
    await expect(emptyStatus).toBeVisible({ timeout: 10_000 });
    await expect(reveal).toHaveCount(0);
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("freezer matrix discloses empty full and bounded overflow scenes", async ({
  page,
}) => {
  const errors = watchErrors(page);
  for (const [viewport, capacity] of [
    [{ width: 1280, height: 720 }, 20],
    [{ width: 800, height: 500 }, 4],
    [{ width: 390, height: 844 }, 6],
    [{ width: 320, height: 640 }, 2],
  ] as const) {
    for (const total of [0, 1, 12]) {
      await page.setViewportSize(viewport);
      await page.goto(`/?preset=ended&agents=${total}&stats`);
      await page.getByRole("button", { name: "Freezer" }).click();
      await expect
        .poll(async () => sceneMetrics(page))
        .toMatchObject({
          view: "freezer",
          endedEntries: total,
          visibleSpirits: Math.min(total, capacity),
        });
      const visible = Math.min(total, capacity);
      await expect(
        page
          .getByRole("navigation", { name: "Ended chefs" })
          .getByRole("button"),
      ).toHaveCount(visible);
      await expect(page.getByLabel("Agent state announcements")).toHaveText(
        `Freezer, ${visible} of ${total} ended chefs shown`,
      );
      if (total === 12 && viewport.width === 1280) {
        const bounds = Object.values(
          (await sceneMetrics(page))!.spiritPoseBounds,
        );
        expect(
          new Set(
            bounds.map(
              ({ width, height }) =>
                `${Math.round(width)}:${Math.round(height)}`,
            ),
          ).size,
        ).toBe(3);
      }
    }
  }
  expect(errors).toEqual([]);
});

test("fixture-driven materials, slots, and readable dense kitchen", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const directory = await mkdtemp(
      join(tmpdir(), "herdr-mise-blocked-density-"),
    ),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    source = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-herdr-0.8.0-p19.json",
        ),
        "utf8",
      ),
    ) as {
      agents: Array<{
        terminal_id: string;
        pane_id: string;
        workspace_id: string;
        display_agent: string;
        agent_status: string;
        agent_session: { value: string };
      }>;
    },
    makeSnapshotFromIds = (ids: readonly string[], status = "blocked") => ({
      ...source,
      agents: ids.map((id) => {
        return {
          ...source.agents[0]!,
          terminal_id: `fictional-terminal-${id}`,
          pane_id: `fictional-pane-${id}`,
          display_agent: id.startsWith("m") ? id : `density-${id}`,
          agent_status: status,
          agent_session: { value: `fictional-session-${id}` },
        };
      }),
    }),
    makeSnapshot = (count: number, status = "blocked") =>
      makeSnapshotFromIds(
        Array.from({ length: count }, (_, index) =>
          String(index + 1).padStart(2, "0"),
        ),
        status,
      ),
    sockets = new Set<Socket>();
  let snapshot = makeSnapshot(1, "working");
  const fixtureServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\n")) return;
      const method = JSON.parse(request).method;
      if (method === "session.snapshot")
        socket.end(`${JSON.stringify({ result: { snapshot } })}\n`);
      else socket.write('{"result":{"type":"subscription_started"}}\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(socketPath, resolve);
  });
  const app = spawn("target/debug/herdr-mise", [], {
    env: {
      ...process.env,
      HERDR_MISE_PORT: String(port),
      HERDR_SOCKET_PATH: socketPath,
    },
    stdio: "ignore",
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(appUrl)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${appUrl}/?stats&theme=light`);
    const workingControl = page.getByRole("button", {
      name: /density-01, Working — on the fire/,
    });
    await expect(workingControl).toBeVisible();
    const workingOn = (await sceneMetrics(page))!;
    expect(workingOn.materials).toMatchObject({
      wallPlanes: 3,
      fixtureShadows: 4,
      passEdges: 3,
      stationGroundings: 1,
    });
    expect(workingOn.materials.floorSeams).toBeGreaterThan(0);
    expectInside(
      workingOn.stationNameBounds["fictional-terminal-01"]!,
      workingOn.stationCells["fictional-terminal-01"]!,
    );
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await expect
      .poll(async () => (await sceneMetrics(page))?.atmosphere)
      .toEqual({
        window: 0,
        shelf: 0,
        pass: 0,
        workingContact: 0,
        freezerAccents: 0,
      });
    expect((await sceneMetrics(page))?.materials).toEqual(workingOn.materials);

    await page.goto(`${appUrl}/?stats&theme=dinner`);
    await page.emulateMedia({ reducedMotion: "reduce" });

    const setLiveIds = async (ids: readonly string[]) => {
        snapshot = makeSnapshotFromIds(ids, "working");
        await expect
          .poll(async () =>
            Object.keys((await sceneMetrics(page))?.stationCells ?? {}),
          )
          .toEqual(
            expect.arrayContaining(ids.map((id) => `fictional-terminal-${id}`)),
          );
        await expect
          .poll(
            async () =>
              Object.keys((await sceneMetrics(page))?.stationCells ?? {})
                .length,
          )
          .toBe(ids.length);
        return (await sceneMetrics(page))!.stationCells;
      },
      expectSurvivorsStationary = (
        before: Record<
          string,
          { x: number; y: number; width: number; height: number }
        >,
        after: Record<
          string,
          { x: number; y: number; width: number; height: number }
        >,
      ) => {
        for (const id of Object.keys(before))
          if (id in after) expect(after[id]).toEqual(before[id]);
      };

    await setLiveIds([]);
    const four = await setLiveIds(["a01", "a02", "a03", "a04"]),
      five = await setLiveIds(["a01", "a02", "a03", "a04", "a05"]);
    expectSurvivorsStationary(four, five);
    const fourAgain = await setLiveIds(["a01", "a02", "a03", "a04"]);
    expectSurvivorsStationary(five, fourAgain);

    const hole = await setLiveIds(["a01", "a03", "a04"]),
      replacement = await setLiveIds(["a01", "a03", "a04", "a99"]);
    expect(replacement["fictional-terminal-a99"]).toEqual(
      five["fictional-terminal-a02"],
    );
    expectSurvivorsStationary(hole, replacement);
    const visualOrder = Object.entries(replacement)
      .sort(([, left], [, right]) => left.y - right.y || left.x - right.x)
      .map(([id]) => id);
    expect(visualOrder.slice(0, 2)).toEqual([
      "fictional-terminal-a01",
      "fictional-terminal-a99",
    ]);
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const replacementControl = page.getByRole("button", {
      name: /density-a99, Working/,
    });
    await expect(replacementControl).toBeFocused();
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.activeFocusBounds[
            "fictional-terminal-a99"
          ],
      )
      .toBeTruthy();
    expectInside(
      (await sceneMetrics(page))!.activeFocusBounds["fictional-terminal-a99"]!,
      replacement["fictional-terminal-a99"]!,
    );

    const eight = await setLiveIds([
        "b01",
        "b02",
        "b03",
        "b04",
        "b05",
        "b06",
        "b07",
        "b08",
      ]),
      nine = await setLiveIds([
        "b01",
        "b02",
        "b03",
        "b04",
        "b05",
        "b06",
        "b07",
        "b08",
        "b09",
      ]);
    expectSurvivorsStationary(eight, nine);
    expectSurvivorsStationary(
      nine,
      await setLiveIds([
        "b01",
        "b02",
        "b03",
        "b04",
        "b05",
        "b06",
        "b07",
        "b08",
      ]),
    );

    await setLiveIds(["c01", "c02", "c03", "c04", "c05", "c06"]);
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.keyboard.press("ArrowRight");
    const survivorControl = page.getByRole("button", {
      name: /density-c01, Working/,
    });
    await expect(survivorControl).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("complementary", { name: /density-c01 details/i }),
    ).toBeVisible();
    await setLiveIds(["c01", "c02", "c03", "c04", "c05", "c06", "c07"]);
    await expect(
      page.getByRole("complementary", { name: /density-c01 details/i }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.activeFocusBounds[
            "fictional-terminal-c01"
          ],
      )
      .toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(survivorControl).toBeFocused();

    await page.emulateMedia({ reducedMotion: "no-preference" });

    for (const count of [1, 4, 8, 16, 30, 60]) {
      for (const viewport of [
        { width: 1280, height: 720 },
        { width: 320, height: 640 },
        { width: 481, height: 360 },
        { width: 640, height: 360 },
      ]) {
        await page.setViewportSize(viewport);
        snapshot = makeSnapshotFromIds(
          Array.from(
            { length: count },
            (_, index) => `m${String(index + 1).padStart(2, "0")}`,
          ),
        );
        const buttons = page
          .getByRole("navigation", { name: "Agent stations" })
          .getByRole("button", { name: /Blocked —/ });
        await expect(buttons).toHaveCount(count, { timeout: 10_000 });
        await expect
          .poll(async () => {
            const metrics = await sceneMetrics(page);
            return metrics?.page.totalCount === count;
          })
          .toBe(true);
        const expected = computeLayout(
          viewport.width,
          viewport.height,
          reconcileStationSlots(
            [],
            Array.from(
              { length: count },
              (_, index) =>
                `fictional-terminal-m${String(index + 1).padStart(2, "0")}`,
            ),
          ),
        );
        await expect
          .poll(async () => (await sceneMetrics(page))?.page)
          .toMatchObject({
            capacity: expected.capacity,
            pageCount: expected.pageCount,
          });
        await expect(page.locator(".appShell")).toHaveAttribute(
          "data-pager-layout",
          expected.pagerLayout,
        );
        let metrics = (await sceneMetrics(page))!;
        while (metrics.page.pageIndex > 0) {
          await page.getByRole("button", { name: "Previous" }).click();
          await expect
            .poll(async () => (await sceneMetrics(page))?.page.pageIndex)
            .toBe(metrics.page.pageIndex - 1);
          metrics = (await sceneMetrics(page))!;
        }
        if (count === 60 && viewport.width === 1280) {
          await page.evaluate(() =>
            (document.activeElement as HTMLElement | null)?.blur(),
          );
          for (let index = 0; index <= expected.capacity; index++)
            await page.keyboard.press("ArrowRight");
          const expectedFocusedId = `fictional-terminal-m${String(expected.capacity + 1).padStart(2, "0")}`;
          await expect(
            page.locator(
              `.stationA11yMirror button[data-agent-id="${expectedFocusedId}"]`,
            ),
          ).toBeFocused();
          await expect
            .poll(async () => (await sceneMetrics(page))?.page.visibleIds)
            .toContain(expectedFocusedId);
          await page.getByRole("button", { name: "Previous" }).click();
          await expect
            .poll(async () => (await sceneMetrics(page))?.page.pageIndex)
            .toBe(0);
        }
        const discovered = new Set<string>();
        metrics = (await sceneMetrics(page))!;
        expect(metrics.page.capacity).toBe(expected.capacity);
        expect(metrics.page.pageCount).toBe(expected.pageCount);
        for (
          let pageIndex = 0;
          pageIndex < metrics.page.pageCount;
          pageIndex++
        ) {
          await expect
            .poll(async () => {
              const current = await sceneMetrics(page);
              return (
                current?.page.pageIndex === pageIndex &&
                Object.values(current.stationCells).every(
                  (cell) =>
                    cell.x >= 0 &&
                    cell.y >= 0 &&
                    cell.x + cell.width <= viewport.width + 0.001 &&
                    cell.y + cell.height <= viewport.height + 0.001,
                )
              );
            })
            .toBe(true);
          metrics = (await sceneMetrics(page))!;
          const pager =
            metrics.page.pageCount > 1
              ? await page
                  .getByRole("navigation", { name: "Kitchen pages" })
                  .boundingBox()
              : null;
          if (pager)
            expect(
              await page
                .getByRole("navigation", { name: "Kitchen pages" })
                .evaluate(
                  (element) => element.scrollWidth <= element.clientWidth,
                ),
            ).toBe(true);
          if (pager)
            for (const button of await page
              .getByRole("navigation", { name: "Kitchen pages" })
              .getByRole("button")
              .all()) {
              const box = await button.boundingBox();
              expect(box?.width).toBeGreaterThanOrEqual(44);
              expect(box?.height).toBeGreaterThanOrEqual(44);
            }
          if (pager && pageIndex === 0) {
            const hint = await page.locator(".firstHint").boundingBox();
            expect(hint).not.toBeNull();
            expect(boxesIntersect(hint!, pager)).toBe(false);
          }
          expect(metrics.page.pageIndex).toBe(pageIndex);
          expect(
            await buttons.evaluateAll((controls) =>
              controls.map((control) => control.dataset.agentId),
            ),
          ).toEqual(
            Array.from(
              { length: count },
              (_, index) =>
                `fictional-terminal-m${String(index + 1).padStart(2, "0")}`,
            ),
          );
          expect(metrics.page.visibleIds).toEqual(
            Object.keys(metrics.stationCells),
          );
          if (metrics.page.pageCount > 1)
            await expect(
              page.getByText(
                `${metrics.page.visibleIds.length} of ${count} cooks shown · ${count} blocked / ${count - metrics.page.visibleIds.length} off-page`,
              ),
            ).toBeVisible();
          if (count === 16 && viewport.width === 320 && pageIndex === 0) {
            await page.getByRole("button", { name: "Open settings" }).click();
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: "Freezer" }).click();
            await expect
              .poll(async () => (await sceneMetrics(page))?.view)
              .toBe("freezer");
            await page.getByRole("button", { name: "Freezer" }).click();
            await expect
              .poll(async () => (await sceneMetrics(page))?.view)
              .toBe("kitchen");
          }
          const cells = Object.entries(metrics.stationCells);
          for (const [id, cell] of cells) {
            discovered.add(id);
            expect(cell.x).toBeGreaterThanOrEqual(0);
            expect(cell.y).toBeGreaterThanOrEqual(0);
            expect(cell.x + cell.width).toBeLessThanOrEqual(
              viewport.width + 0.001,
            );
            expect(cell.y + cell.height).toBeLessThanOrEqual(
              viewport.height + 0.001,
            );
            if (pager)
              expect(cell.y + cell.height).toBeLessThanOrEqual(pager.y);
            expectInside(metrics.stationNameBounds[id]!, cell);
            expectInside(metrics.stationStatusBounds[id]!, cell);
            expect(
              boxesIntersect(
                metrics.stationNameBounds[id]!,
                metrics.stationStatusBounds[id]!,
              ),
            ).toBe(false);
          }
          cells.forEach(([, cell], index) => {
            for (const [otherId, other] of cells.slice(index + 1))
              expect(
                boxesIntersect(
                  {
                    ...cell,
                    width: cell.width - 0.001,
                    height: cell.height - 0.001,
                  },
                  other,
                ),
                `${count}@${viewport.width}x${viewport.height} ${cells[index]![0]} ${JSON.stringify(cell)} overlaps ${otherId} ${JSON.stringify(other)}`,
              ).toBe(false);
          });
          const placements = Object.values(metrics.blockedPlacements).sort(
            (left, right) => left.queueOrdinal - right.queueOrdinal,
          );
          expect(placements).toHaveLength(metrics.page.visibleIds.length);
          expect(
            placements.every(({ queueTotal }) => queueTotal === count),
          ).toBe(true);
          for (const placement of placements) {
            expect(placement.queueOrdinal).toBe(Number(placement.id.slice(-2)));
            expect(placement.timerText).toMatch(/^\d+:\d{2}$/);
            expect(metrics.stationStatusBounds[placement.id]?.text).toBe(
              `${placement.kind === "pass" ? "AT THE PASS" : "BLOCKED AT STATION"} · ${placement.queueOrdinal}/${count}`,
            );
          }
          if (pageIndex < metrics.page.pageCount - 1) {
            await page
              .getByRole("button", { name: "Next", exact: true })
              .click();
            await expect
              .poll(async () => (await sceneMetrics(page))?.page.pageIndex)
              .toBe(pageIndex + 1);
          }
        }
        expect([...discovered].sort()).toEqual(
          Array.from(
            { length: count },
            (_, index) =>
              `fictional-terminal-m${String(index + 1).padStart(2, "0")}`,
          ),
        );
        if (count === 16 && viewport.width === 1280) {
          expect(metrics.materials).toMatchObject({
            wallPlanes: 3,
            fixtureShadows: 4,
            passEdges: 3,
            stationGroundings: metrics.page.visibleIds.length,
          });
          await page.getByRole("button", { name: "Open settings" }).click();
          await page.getByRole("switch", { name: "Atmosphere" }).click();
          await expect
            .poll(async () => (await sceneMetrics(page))?.atmosphere.pass)
            .toBeGreaterThan(0);
          expect((await sceneMetrics(page))?.materials).toEqual(
            metrics.materials,
          );
          await page.keyboard.press("Escape");
        }
        if (metrics.page.pageCount === 1) {
          const placements = Object.values(metrics.blockedPlacements).sort(
            (left, right) => left.queueOrdinal - right.queueOrdinal,
          );
          expect(placements.map(({ queueOrdinal }) => queueOrdinal)).toEqual(
            Array.from({ length: count }, (_, index) => index + 1),
          );
          expect(
            placements.every(({ queueTotal }) => queueTotal === count),
          ).toBe(true);
          expect(placements.map(({ kind }) => kind).join(",")).toMatch(
            /^pass(?:,pass)*(?:,station)*$/,
          );
          for (const [index, placement] of placements.entries()) {
            expect(placement.timerText).toMatch(/^\d+:\d{2}$/);
            expect(metrics.stationNameBounds[placement.id]?.text).toContain(
              String(index + 1).padStart(2, "0"),
            );
            expect(metrics.stationStatusBounds[placement.id]?.text).toBe(
              `${placement.kind === "pass" ? "AT THE PASS" : "BLOCKED AT STATION"} · ${index + 1}/${count}`,
            );
            const control = buttons.nth(index);
            await expect(control).toContainText(
              `m${String(index + 1).padStart(2, "0")}`,
            );
            await expect(control).toContainText(
              placement.kind === "pass"
                ? "Blocked — at the pass"
                : "Blocked — waiting at station",
            );
            await expect(control).toContainText(
              `queue ${index + 1} of ${count}`,
            );
            await expect(control).toContainText(/\d+(?:h|m|s)/);
            if (placement.kind === "station")
              for (const bound of [
                placement.cookBounds,
                placement.ticket,
                placement.timer,
              ])
                expectInside(bound, metrics.stationCells[placement.id]!);
          }
          const passBounds = placements
            .filter(({ kind }) => kind === "pass")
            .flatMap((placement) => [
              placement.cookBounds,
              placement.ticket,
              placement.timer,
            ]);
          passBounds.forEach((bound, index) => {
            expect(boxesIntersect(bound, placements[0]!.bell)).toBe(false);
            for (const other of passBounds.slice(index + 1))
              expect(boxesIntersect(bound, other)).toBe(false);
          });

          await page.getByRole("button", { name: "Freezer" }).click();
          await page.getByRole("button", { name: "Freezer" }).click();
          await expect
            .poll(async () => (await sceneMetrics(page))?.view)
            .toBe("kitchen");
        }
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.blur(),
        );
        const visibleCount = (await sceneMetrics(page))!.page.visibleIds.length,
          focused = await cycleSceneFocus(page, visibleCount);
        expect(focused.stationIds.size).toBe(visibleCount);
        const active = page.locator(".stationA11yMirror button:focus");
        await expect(active).toHaveCount(1);
        const activeId = await active.getAttribute("data-agent-id");
        expect(activeId).not.toBeNull();
        await page.keyboard.press("Enter");
        await expect(
          page.getByRole("complementary", { name: /details$/ }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (document.activeElement as HTMLElement | null)?.dataset.agentId,
            ),
          )
          .toBe(activeId);
        if (count === 60 && viewport.width === 1280) {
          const found = new Set<string>();
          for (let index = 0; index < count; index++) {
            await page
              .getByRole("button", { name: "Next blocked cook" })
              .click();
            await expect
              .poll(async () => {
                const current = (await sceneMetrics(page))!,
                  [id] = Object.keys(current.activeFocusBounds);
                return id && current.page.visibleIds.includes(id) ? id : null;
              })
              .not.toBeNull();
            found.add(
              Object.keys((await sceneMetrics(page))!.activeFocusBounds)[0]!,
            );
          }
          expect(found.size).toBe(count);
        }
      }
    }

    await page.setViewportSize({ width: 320, height: 640 });
    snapshot = makeSnapshot(12);
    await expect
      .poll(async () => (await sceneMetrics(page))?.page.totalCount)
      .toBe(12);
    let transitionPage = (await sceneMetrics(page))!.page.pageIndex;
    while (transitionPage > 0) {
      await page.getByRole("button", { name: "Previous" }).click();
      await expect
        .poll(async () => (await sceneMetrics(page))?.page.pageIndex)
        .toBe(transitionPage - 1);
      transitionPage = (await sceneMetrics(page))!.page.pageIndex;
    }
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.blockedPlacements[
            "fictional-terminal-01"
          ],
      )
      .not.toBeUndefined();
    snapshot = structuredClone(snapshot);
    snapshot.agents[0]!.agent_status = "working";
    await expect(
      page.getByRole("button", { name: /density-01, Working/ }),
    ).toBeAttached();
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.blockedPlacements["fictional-terminal-01"]
            ?.exiting,
      )
      .toBe(true);
    const duringExit = Object.values(
      (await sceneMetrics(page))!.blockedPlacements,
    );
    duringExit.forEach((placement, index) => {
      for (const other of duringExit.slice(index + 1))
        for (const bound of [
          placement.cookBounds,
          placement.ticket,
          placement.timer,
        ])
          for (const otherBound of [
            other.cookBounds,
            other.ticket,
            other.timer,
          ])
            expect(
              boxesIntersect(bound, otherBound),
              `${placement.id} ${JSON.stringify(bound)} intersects ${other.id} ${JSON.stringify(otherBound)}`,
            ).toBe(false);
    });
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.blockedPlacements[
            "fictional-terminal-01"
          ],
      )
      .toBeUndefined();

    snapshot = structuredClone(snapshot);
    snapshot.agents[1]!.agent_status = "done";
    await expect(
      page.getByRole("button", { name: /density-02, Done/ }),
    ).toBeAttached({ timeout: 10_000 });
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.blockedPlacements["fictional-terminal-02"]
            ?.exiting,
      )
      .toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(async () => ({
        retained: (await sceneMetrics(page))?.blockedPlacements[
          "fictional-terminal-02"
        ],
        transitions: (await sceneMetrics(page))?.motion.activeTransitions,
      }))
      .toEqual({ retained: undefined, transitions: 0 });

    snapshot = structuredClone(snapshot);
    snapshot.agents[2]!.agent_status = "working";
    await expect(
      page.getByRole("button", { name: /density-03, Working/ }),
    ).toBeAttached({ timeout: 10_000 });
    await expect
      .poll(async () => ({
        retained: (await sceneMetrics(page))?.blockedPlacements[
          "fictional-terminal-03"
        ],
        transitions: (await sceneMetrics(page))?.motion.activeTransitions,
      }))
      .toEqual({ retained: undefined, transitions: 0 });

    snapshot = makeSnapshot(12);
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.blockedPlacements[
            "fictional-terminal-01"
          ],
      )
      .not.toBeUndefined();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    snapshot = structuredClone(snapshot);
    snapshot.agents[0]!.agent_status = "working";
    await expect(
      page.getByRole("button", { name: /density-01, Working/ }),
    ).toBeAttached();
    await expect(
      page.getByText("6 of 12 cooks shown · 11 blocked / 6 off-page"),
    ).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    snapshot = makeSnapshot(30);
    const selectedId = "fictional-terminal-20",
      liveButtons = page
        .getByRole("navigation", { name: "Agent stations" })
        .getByRole("button", { name: /Blocked —/ });
    await expect(liveButtons).toHaveCount(30);
    await liveButtons.nth(19).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("complementary", { name: /density-20 details/i }),
    ).toBeVisible();
    const reversed = makeSnapshot(30);
    reversed.agents.reverse();
    reversed.agents.find(
      (agent) => agent.terminal_id === selectedId,
    )!.agent_status = "working";
    for (const next of [
      reversed,
      makeSnapshot(60),
      {
        ...makeSnapshot(5),
        agents: makeSnapshot(30).agents.slice(17, 22),
      },
    ]) {
      snapshot = next;
      await expect
        .poll(async () => {
          const current = (await sceneMetrics(page))!;
          return current.page.visibleIds.includes(selectedId);
        })
        .toBe(true);
      await expect(
        page.getByRole("complementary", { name: /density-20 details/i }),
      ).toBeVisible();
      if (next === reversed) {
        const current = (await sceneMetrics(page))!;
        await expect(
          page.getByText(
            `${current.page.visibleIds.length} of 30 cooks shown · 29 blocked / ${30 - current.page.visibleIds.length} off-page`,
          ),
        ).toBeVisible();
      }
    }
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("atmosphere persists across the production fixture runtime", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-atmosphere-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    fixture = await readFile(
      join(process.cwd(), "protocol/fixtures/snapshot.v1.json"),
      "utf8",
    ),
    app = spawn("target/debug/herdr-mise", [], {
      env: {
        ...process.env,
        HERDR_MISE_PORT: String(port),
        HERDR_SOCKET_PATH: join(directory, "herdr.sock"),
      },
      stdio: "ignore",
    });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(appUrl)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await page.routeWebSocket("**/ws?paneId=1", (webSocket) => {
      webSocket.send(fixture);
    });
    await page.goto(`${appUrl}/?stats`);
    await expect(
      page.getByRole("button", {
        name: "refactor-agent, Working — on the fire, open details",
      }),
    ).toBeAttached();
    await expect(
      page.getByRole("button", {
        name: "review-agent, Idle — prepping, open details",
      }),
    ).toBeAttached();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        atmosphere: { shelf: 2 },
        board: { headers: ["COOK", "MISE TIME"] },
      });

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({ atmosphere: { window: 0, shelf: 0, pass: 0 } });

    await page.reload();
    await expect(
      page.getByRole("button", {
        name: "refactor-agent, Working — on the fire, open details",
      }),
    ).toBeAttached();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        atmosphere: { window: 0, shelf: 0, pass: 0 },
        board: { headers: ["COOK", "MISE TIME"] },
      });
    await page.getByRole("button", { name: "Open settings" }).click();
    await expect(
      page.getByRole("switch", { name: "Atmosphere" }),
    ).toHaveAttribute("aria-checked", "false");
  } finally {
    app.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejected state update resynchronizes through a fresh snapshot", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-rejection-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    snapshot = await readFile(
      join(process.cwd(), "protocol/fixtures/snapshot.v1.json"),
      "utf8",
    ),
    delta = JSON.parse(
      await readFile(
        join(process.cwd(), "protocol/fixtures/delta-upsert.v1.json"),
        "utf8",
      ),
    ) as { agent: { name: string } },
    heartbeat = await readFile(
      join(process.cwd(), "protocol/fixtures/heartbeat.v1.json"),
      "utf8",
    ),
    rejected = JSON.stringify({
      ...delta,
      agent: { ...delta.agent, name: "x".repeat(4097) },
    }),
    app = spawn("target/debug/herdr-mise", [], {
      env: {
        ...process.env,
        HERDR_MISE_PORT: String(port),
        HERDR_SOCKET_PATH: join(directory, "herdr.sock"),
      },
      stdio: "ignore",
    });
  let connections = 0;
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(appUrl)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await page.routeWebSocket("**/ws?paneId=1", (webSocket) => {
      connections++;
      if (connections === 1) {
        webSocket.send(snapshot);
        webSocket.send(rejected);
        webSocket.send(heartbeat);
      } else if (connections === 2) webSocket.send(rejected);
      else webSocket.send(snapshot);
    });
    await page.goto(appUrl);

    await expect(page.getByRole("alert")).toContainText(
      "Browser received an incompatible Mise feed",
      { timeout: 10_000 },
    );
    await expect(
      page.getByRole("button", { name: /refactor-agent, Blocked/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "refactor-agent, Working — on the fire, open details",
      }),
    ).toBeAttached({ timeout: 10_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(connections).toBeGreaterThanOrEqual(3);
  } finally {
    app.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
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
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 800, height: 500 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`/?preset=ended&agents=${count}&stats`);
      // Visual playground is demo: the emptied kitchen keeps the DEMO placard.
      await expect(placard(page)).toBeVisible();

      const navigation = page.getByRole("navigation", {
          name: "Agent stations",
        }),
        buttons = navigation.getByRole("button");
      await expect(buttons).toHaveCount(Math.min(3, count));
      await expect(buttons.first()).toHaveAttribute("tabindex", "-1");
      await expect
        .poll(async () => sceneMetrics(page))
        .toMatchObject({
          board: { headers: ["COOK", "MISE TIME"] },
        });
      const painted = await sceneMetrics(page);
      expect(painted?.board.rows).toHaveLength(Math.min(3, count));
      for (const row of painted?.board.rows ?? []) {
        expect(row.text[1]).toMatch(/^(?:\d+:\d{2}|—)$/);
        expect(row.text[1]).not.toMatch(/\d+M/);
      }

      // Chrome tooltips remain station-only; board keyboard focus is the
      // chalk row stroke recorded by the Pixi draw branch.
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await expect
        .poll(async () => (await sceneMetrics(page))?.board.strokedIds.length)
        .toBe(1);
      const focused = await sceneMetrics(page),
        focusedId = focused!.board.strokedIds[0]!,
        focusedName = focused!.board.rows.find((row) => row.id === focusedId)!
          .text[0];
      await page.keyboard.press("Enter");
      const summary = page.locator('aside[aria-label$="session summary"]');
      await expect(summary).toBeVisible();
      await expect(summary).toHaveAttribute(
        "aria-label",
        new RegExp(`^${focusedName} session summary$`, "i"),
      );
      await page.keyboard.press("Escape");

      const point = boardRowPoint(viewport.width, viewport.height);
      await page.mouse.click(point.x, point.y);
      await expect(summary).toBeVisible();
      await expect(summary).toContainText("86'D — SESSION ENDED");
      await expect(summary).toContainText("Done — plated");
    }
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

test("invalid preset and count fall back to mixed x 6", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/?preset=bogus&agents=13");
  await expect(placard(page)).toBeVisible();
  const names = await collectStationNames(page, 6);
  expect([...names].sort()).toEqual([...expectedNames("mixed", 6)].sort());
  expect(errors).toEqual([]);
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

test("TUI recording controls stay accessible, bounded, and isolated", async ({
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

  await page.setViewportSize({ width: 901, height: 641 });
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
