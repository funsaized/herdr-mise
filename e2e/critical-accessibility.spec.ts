import { expect, test } from "@playwright/test";

test("blocked agents and settings remain keyboard-accessible at 320 CSS pixels", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Reflow-width coverage equivalent to 1280px at 400% zoom; not an AT listening test.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/?preset=blocked&agents=12&stats");
  await expect(
    page.getByRole("status").filter({ hasText: "DEMO SERVICE" }),
  ).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("ArrowLeft");
  const station = page.locator(".stationA11yMirror button:focus"),
    selectedAgentId = await station.getAttribute("data-agent-id");
  expect(selectedAgentId).not.toBeNull();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: /details$/ });
  await expect(panel).toBeVisible();
  const selectedBox = await page.evaluate(() => {
    const metrics = (
      window as typeof window & {
        __miseSceneMetrics?: () => {
          activeFocusBounds: Record<
            string,
            { x: number; y: number; width: number; height: number }
          >;
        };
      }
    ).__miseSceneMetrics?.();
    return Object.values(metrics?.activeFocusBounds ?? {})[0];
  });
  if (selectedBox) {
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.y).toBeGreaterThanOrEqual(
      selectedBox.y + selectedBox.height,
    );
  } else {
    await expect(
      page.getByRole("region", { name: "Agent status list" }),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(
    page.locator(`[data-agent-id="${selectedAgentId}"]`),
  ).toBeFocused();
  const settings = page.getByRole("button", { name: /settings/i }).first();
  await settings.focus();
  await page.keyboard.press("Enter");
  const settingsPanel = page.getByRole("complementary", { name: "Settings" });
  await expect(settingsPanel).toBeVisible();
  if (selectedBox) {
    const settingsBox = (await settingsPanel.boundingBox())!;
    expect(settingsBox.y).toBeGreaterThanOrEqual(
      selectedBox.y + selectedBox.height,
    );
  }
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("renderer failure keeps a visible operable agent list", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      ...args: Parameters<typeof original>
    ) {
      if (String(args[0]).includes("webgl")) return null;
      return Reflect.apply(original, this, args);
    } as typeof original;
  });
  await page.goto("/?preset=blocked&agents=1");
  const fallback = page.getByRole("region", { name: "Agent status list" });
  await expect(fallback).toBeVisible();
  await expect(fallback.getByRole("alert")).toContainText(
    "graphics could not start",
  );
  await fallback.getByRole("button").first().click();
  await expect(
    page.getByRole("complementary", { name: /details$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(fallback.getByRole("button").first()).toBeFocused();
  expect(errors).toEqual([]);
});

test("workspace scope reveals blocked agents by keyboard at 320 CSS pixels", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/?preset=mixed&agents=2");
  const selector = page.getByRole("combobox", { name: "Workspace" });
  await expect(selector).toHaveValue("");
  await selector.selectOption("visual-workspace-1");
  const showAll = page.getByRole("button", {
    name: "1 blocked elsewhere — Show all",
  });
  await expect(showAll).toBeVisible();
  const showAllBox = await showAll.boundingBox();
  expect(showAllBox).not.toBeNull();
  if (
    !(await page.getByRole("region", { name: "Agent status list" }).isVisible())
  ) {
    const placardBox = await page.locator(".demoPlacard").boundingBox();
    expect(placardBox).not.toBeNull();
    expect(showAllBox!.y + showAllBox!.height).toBeLessThanOrEqual(
      placardBox!.y,
    );
  }
  await showAll.click();
  await expect(selector).toBeFocused();
  await selector.selectOption("visual-workspace-1");
  await selector.focus();
  await page.keyboard.press("Tab");
  await expect(showAll).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(selector).toBeFocused();
  await expect(selector).toHaveValue("");
  await expect(
    page.getByRole("button", { name: /Claude, Blocked — .*open details/ }),
  ).toBeAttached();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
