import { test, expect } from "@playwright/test";
import {
  COUNTS,
  STATE_WORDS,
  expectedNames,
  watchErrors,
  sceneMetrics,
  placard,
  boxesIntersect,
  boardRowPoint,
  collectStationNames,
} from "./visual-helpers";

test("attention demo identifies Codex blocking checkout-api and resuming", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?preset=attention&agents=6&theme=light&stats");
  await expect(placard(page)).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Agent stations" })
      .getByRole("button"),
  ).toHaveCount(6);
  await expect(
    page.getByRole("button", {
      name: "Codex, Working — on the fire, open details",
    }),
  ).toBeVisible();
  const codex = page.getByRole("button", {
      name: /Codex, Blocked — at the pass.*open details/,
    }),
    details = page.getByRole("complementary", { name: "Codex details" });
  await expect(codex).toBeVisible({ timeout: 6_000 });
  await expect(
    page.locator('.stationA11yMirror button[aria-label*="Blocked —"]'),
  ).toHaveCount(1);
  await codex.evaluate((element) => element.click());
  await expect(details).toContainText("BLOCKED — AT THE PASS");
  await expect(details).toContainText("checkout-api");
  await expect
    .poll(async () => sceneMetrics(page))
    .toMatchObject({
      blockedIndicators: 1,
      motion: {
        reduced: true,
        activeParticles: 0,
        activeTransitions: 0,
        activeBusserSweeps: 0,
        continuous: false,
      },
    });
  await expect(details).toContainText("WORKING — ON THE FIRE", {
    timeout: 7_000,
  });
  await expect(details).toContainText("checkout-api");
  await expect(
    page.getByRole("button", {
      name: "Codex, Working — on the fire, open details",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("freezer matrix discloses and traverses 0 4 12 and 50 retained sessions", async ({
  page,
}) => {
  const errors = watchErrors(page);
  for (const [viewport, capacity] of [
    [{ width: 1280, height: 720 }, 20],
    [{ width: 320, height: 640 }, 2],
  ] as const) {
    for (const total of [0, 4, 12, 50]) {
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
      ).toHaveCount(total);
      const inspector = await page.locator(".freezerInspector").boundingBox(),
        service = await page.locator(".serviceStrip").boundingBox();
      expect(inspector).not.toBeNull();
      expect(service).not.toBeNull();
      expect(boxesIntersect(inspector!, service!)).toBe(false);
      const retention = total === 50 ? ", latest 50 retained" : "";
      await expect(page.getByLabel("Agent state announcements")).toHaveText(
        total === 0
          ? "Freezer empty, no ended sessions"
          : `Freezer, ${visible} decorative spirits, ${total} inspectable sessions${visible < total ? `, ${total - visible} not shown as spirits` : ""}${retention}`,
      );
      if (total > 0) {
        const buttons = page
          .getByRole("navigation", { name: "Ended chefs" })
          .getByRole("button");
        expect(
          await buttons.evaluateAll((items) =>
            items.map((item) => item.getAttribute("data-agent-id")),
          ),
        ).toEqual(
          Array.from(
            { length: total },
            (_, index) => `visual-agent-${total - index}`,
          ),
        );
        await buttons.last().click();
        const summary = page.getByRole("complementary", {
          name: "mise-01 session summary",
        });
        await expect(summary).toBeVisible();
        if (viewport.width === 320) {
          const inspector = await page
              .locator(".freezerInspector")
              .boundingBox(),
            service = await page.locator(".serviceStrip").boundingBox(),
            summaryBox = await summary.boundingBox();
          expect(inspector).not.toBeNull();
          expect(service).not.toBeNull();
          expect(summaryBox).not.toBeNull();
          expect(boxesIntersect(inspector!, service!)).toBe(false);
          expect(boxesIntersect(inspector!, summaryBox!)).toBe(false);
        }
        await page.keyboard.press("Escape");
        await expect(buttons.last()).toBeFocused();
      }
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
