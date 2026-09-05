import { expect, test } from "@playwright/test";

test("blocked agents and settings remain keyboard-accessible at 320 CSS pixels", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Reflow-width coverage equivalent to 1280px at 400% zoom; not an AT listening test.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/?preset=blocked&agents=1");
  await expect(
    page.getByRole("status").filter({ hasText: "DEMO SERVICE" }),
  ).toBeVisible();
  const station = page
    .getByRole("button", { name: /Blocked — at the pass, open details/ })
    .first();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("ArrowRight");
  await expect(station).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("complementary", { name: /details$/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(station).toBeFocused();
  const settings = page.getByRole("button", { name: /settings/i }).first();
  await settings.focus();
  await page.keyboard.press("Enter");
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
