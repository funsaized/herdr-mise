import { expect, type Page } from "@playwright/test";
import { createServer } from "node:net";
import { computeLayout } from "../client/src/scene/layout";

export const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export const STATE_WORDS = {
  idle: "Idle — prepping",
  working: "Working — on the fire",
  blocked: "Blocked —",
  done: "Done — plated",
} as const;

export const IDENTITIES = [
  "Codex",
  "Claude",
  "Hermes",
  "OpenClaw",
  "Gemini",
  "Aider",
];

export function expectedNames(preset: string, count: number) {
  return new Set(
    Array.from({ length: count }, (_, index) => {
      if (preset !== "mixed" && preset !== "attention")
        return `mise-${String(index + 1).padStart(2, "0")}`;
      const cycle = Math.floor(index / IDENTITIES.length) + 1;
      return `${IDENTITIES[index % IDENTITIES.length]}${cycle > 1 ? `-${cycle}` : ""}`;
    }),
  );
}

export function watchErrors(page: Page) {
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

export type MotionMetrics = {
  renderCount: number;
  rafCount: number;
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

export type Box = { x: number; y: number; width: number; height: number };

export const sceneMetrics = (page: Page) =>
  page.evaluate(() =>
    (
      window as typeof window & { __miseSceneMetrics?: () => MotionMetrics }
    ).__miseSceneMetrics?.(),
  );

export const placard = (page: Page) =>
  page.getByRole("status").filter({ hasText: "DEMO SERVICE" });

export async function availablePort() {
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

export function boxesIntersect(first: Box, second: Box) {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

export const FULL_STATUSES = new Set([
  "PREP",
  "FIRE",
  "AT THE PASS",
  "BLOCKED AT STATION",
  "PLATED",
  "86'D",
  "WORK RESUMED",
  "UNKNOWN · PREP",
]);

export function expectInside(inner: Box, outer: Box, tolerance = 3) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - tolerance);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - tolerance);
  expect(inner.x + inner.width).toBeLessThanOrEqual(
    outer.x + outer.width + tolerance,
  );
  expect(inner.y + inner.height).toBeLessThanOrEqual(
    outer.y + outer.height + tolerance,
  );
}

export async function cycleSceneFocus(page: Page, count: number) {
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

export async function assertResponsiveScene(
  page: Page,
  count: number,
  demo: boolean,
) {
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

export function boardRowPoint(width: number, height: number) {
  const layout = computeLayout(width, height, []),
    boardWidth = Math.min(layout.unit * 92, layout.wall.width * 0.36);
  return {
    x: (layout.wall.width - boardWidth) / 2 + layout.unit * 3 + 16,
    y: layout.unit * (4 + 12) + 4,
  };
}

export async function collectStationNames(page: Page, expected: number) {
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
