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
import { computeLayout } from "../client/src/scene/layout";

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
  stateIndicators: Record<string, number>;
  endedEntries: number;
  stationVisuals: Record<
    string,
    { accent: string; idlePose: string | null; prepStep: 0 | 1 | null }
  >;
  spiritAccents: Record<string, string>;
  stationCells: Record<string, Box>;
  stationNameBounds: Record<string, Box & { text: string }>;
  stationStatusBounds: Record<string, Box & { text: string }>;
  activeFocusBounds: Record<string, Box>;
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
  "ANSWER RECEIVED",
  "UNKNOWN · PREP",
]);

function expectInside(inner: Box, outer: Box, tolerance = 2) {
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
      const cells = Object.values(
          (await sceneMetrics(page))?.stationCells ?? {},
        ),
        viewport = page.viewportSize()!;
      return (
        cells.length === count &&
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
  await cycleSceneFocus(page, count);
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
  const errors = watchErrors(page);
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

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        atmosphere: { window: 0, shelf: 0, pass: 0 },
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
      page.getByRole("button", {
        name: new RegExp(`mise-01, ${label}.*open details`),
      }),
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

test("authoritative fixture drives rendered feed accents poses prep and freezer spirits", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-freezer-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
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
    sockets = new Set<Socket>();
  let snapshot = working;
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
      .poll(async () => (await sceneMetrics(page))?.stationVisuals["p-11"])
      .toMatchObject({ accent: "#667a9e", idlePose: null });
    await expect
      .poll(async () => (await sceneMetrics(page))?.stationVisuals["p-8"])
      .toMatchObject({ accent: "#997f5e", prepStep: null });
    expect(
      (await sceneMetrics(page))?.stationVisuals["p-8"]?.idlePose,
    ).not.toMatch(/prep|smoke/i);
    const firstPrepStep = (await sceneMetrics(page))?.stationVisuals["p-11"]
      ?.prepStep;
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.stationVisuals["p-11"]?.prepStep !==
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
        board: {
          headers: ["COOK", "MISE TIME"],
        },
      });
    const rows = (await sceneMetrics(page))?.board.rows
      .map((row) => row.text)
      .sort(([left], [right]) => left!.localeCompare(right!));
    expect(rows?.map(([name]) => name)).toEqual([
      "FIXTURE-IDLE",
      "FIXTURE-WORKING",
    ]);
    for (const [, runtime] of rows ?? [])
      expect(runtime).toMatch(/^(?:—|\d+:\d{2})$/);
    await boardButton.evaluate((element) =>
      (element as HTMLButtonElement).click(),
    );
    await expect(
      page.locator('aside[aria-label$="session summary" i]'),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Freezer" }).click();
    await expect(
      page.getByRole("navigation", { name: "Ended chefs" }).getByRole("button"),
    ).toHaveCount(2);
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        view: "freezer",
        endedEntries: 2,
        visibleSpirits: 2,
        spiritAccents: { "p-11": "#667a9e", "p-8": "#997f5e" },
      });
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocked pass density", async ({ page }) => {
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
        pane_id: string;
        workspace_id: string;
        display_agent: string;
        agent_status: string;
        agent_session: { value: string };
      }>;
    },
    makeSnapshot = (count: number) => ({
      ...source,
      agents: Array.from({ length: count }, (_, index) => {
        const suffix = String(index + 1).padStart(2, "0");
        return {
          ...source.agents[0]!,
          pane_id: `fictional-pane-${suffix}`,
          display_agent: `density-${suffix}`,
          agent_session: { value: `fictional-session-${suffix}` },
        };
      }),
    }),
    sockets = new Set<Socket>();
  let snapshot = makeSnapshot(1);
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
    await page.goto(`${appUrl}/?stats&theme=dinner`);

    for (const count of [1, 6, 12]) {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
        { width: 320, height: 640 },
      ]) {
        await page.setViewportSize(viewport);
        snapshot = makeSnapshot(count);
        const buttons = page
          .getByRole("navigation", { name: "Agent stations" })
          .getByRole("button", { name: /Blocked —/ });
        await expect(buttons).toHaveCount(count, { timeout: 10_000 });
        await expect
          .poll(async () =>
            Object.keys((await sceneMetrics(page))?.blockedPlacements ?? {}),
          )
          .toHaveLength(count);
        await expect
          .poll(async () => {
            const cells = Object.values(
              (await sceneMetrics(page))?.stationCells ?? {},
            );
            return (
              cells.length === count &&
              cells.every(
                (cell) =>
                  cell.x >= 0 && cell.x + cell.width <= viewport.width + 0.001,
              )
            );
          })
          .toBe(true);
        const metrics = (await sceneMetrics(page))!,
          placements = Object.values(metrics.blockedPlacements).sort(
            (left, right) => left.queueOrdinal - right.queueOrdinal,
          );
        expect(placements.map(({ queueOrdinal }) => queueOrdinal)).toEqual(
          Array.from({ length: count }, (_, index) => index + 1),
        );
        expect(placements.every(({ queueTotal }) => queueTotal === count)).toBe(
          true,
        );
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
            `density-${String(index + 1).padStart(2, "0")}`,
          );
          await expect(control).toContainText(
            placement.kind === "pass"
              ? "Blocked — at the pass"
              : "Blocked — waiting at station",
          );
          await expect(control).toContainText(`queue ${index + 1} of ${count}`);
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

        await page.evaluate(() => document.body.focus());
        const focused = await cycleSceneFocus(page, count);
        expect(focused.stationIds.size).toBe(count);
        const active = page.locator(".stationA11yMirror button:focus");
        await expect(active).toHaveCount(1);
        const activeIndex = await buttons.evaluateAll((controls) =>
          controls.findIndex((control) => control === document.activeElement),
        );
        await page.keyboard.press("Enter");
        await expect(
          page.getByRole("complementary", { name: /details$/ }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(buttons.nth(activeIndex)).toBeFocused();

        if (count === 12 && viewport.width === 320) {
          snapshot = structuredClone(snapshot);
          snapshot.agents[0]!.agent_status = "working";
          await expect(
            page.getByRole("button", { name: /density-01, Working/ }),
          ).toBeAttached({ timeout: 10_000 });
          await expect
            .poll(async () => {
              const current = (await sceneMetrics(page))?.blockedPlacements;
              return current?.["fictional-pane-01"]?.exiting;
            })
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
            .poll(async () => {
              return (await sceneMetrics(page))?.blockedPlacements[
                "fictional-pane-01"
              ];
            })
            .toBeUndefined();

          snapshot = structuredClone(snapshot);
          snapshot.agents[1]!.agent_status = "done";
          await expect(
            page.getByRole("button", { name: /density-02, Done/ }),
          ).toBeAttached({ timeout: 10_000 });
          await expect
            .poll(
              async () =>
                (await sceneMetrics(page))?.blockedPlacements[
                  "fictional-pane-02"
                ]?.exiting,
            )
            .toBe(true);
          await page.emulateMedia({ reducedMotion: "reduce" });
          await expect
            .poll(async () => ({
              retained: (await sceneMetrics(page))?.blockedPlacements[
                "fictional-pane-02"
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
                "fictional-pane-03"
              ],
              transitions: (await sceneMetrics(page))?.motion.activeTransitions,
            }))
            .toEqual({ retained: undefined, transitions: 0 });
        }
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
    await page.routeWebSocket("**/ws", (webSocket) => {
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
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute(
    "alt",
    "The herdr-mise terminal demo moving from the kitchen to the walk-in freezer.",
  );
  await expect(figureBox).toHaveAttribute(
    "aria-describedby",
    "tui-demo-description",
  );
  await expect(page.locator("#tui-demo-description")).toHaveText(description);
  await expect(caption).toBeVisible();
  await expect(stop).toBeVisible();
  await expect(expand).toBeVisible();
  await expect(figure).toHaveAttribute("src", "/tui-demo.gif");
  const defaultBox = await figureBox.boundingBox();
  expect(defaultBox).not.toBeNull();
  expect(defaultBox!.width).toBeGreaterThanOrEqual(319);
  expect(defaultBox!.width).toBeLessThanOrEqual(321);
  await figureBox.hover();
  await expect
    .poll(async () => (await figureBox.boundingBox())?.width)
    .toBeGreaterThanOrEqual(319);
  const hoverBox = await figureBox.boundingBox(),
    settingsBox = await settings.boundingBox();
  expect(hoverBox).not.toBeNull();
  expect(hoverBox!.width).toBeLessThanOrEqual(321);
  expect(settingsBox).not.toBeNull();
  expect(boxesIntersect(hoverBox!, settingsBox!)).toBe(false);
  const mediaBox = await figure.boundingBox(),
    stopBox = await stop.boundingBox(),
    expandBox = await expand.boundingBox();
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
