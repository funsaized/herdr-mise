// Browser acceptance for the visual playground matrix: every preset x
// supported count, the dinner theme URL, invalid-query fallback, storage
// isolation, native WebSocket delegation for non-/ws traffic (Vite HMR), and
// liveness beyond the client
// stale timeout. Runs against `npm run dev:visual` via the webServer config.
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
  return new Set(Array.from({ length: count }, (_, index) => {
    if (preset !== "mixed") return `mise-${String(index + 1).padStart(2, "0")}`;
    const cycle = Math.floor(index / IDENTITIES.length) + 1;
    return `${IDENTITIES[index % IDENTITIES.length]}${cycle > 1 ? `-${cycle}` : ""}`;
  }));
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

const placard = (page: Page) => page.getByRole("status").filter({ hasText: "DEMO SERVICE" });

// Keyboard-cycle station focus and collect tooltip names until every
// expected station has been seen. Hit regions appear only after scene init,
// so the loop tolerates early presses that produce no tooltip.
async function collectStationNames(page: Page, expected: number) {
  const names = new Set<string>();
  const deadline = Date.now() + 25_000;
  while (names.size < expected && Date.now() < deadline) {
    await page.keyboard.press("ArrowRight");
    try {
      const name = await page.getByRole("tooltip").locator("strong")
        .textContent({ timeout: 1_000 });
      if (name) names.add(name);
    } catch { /* scene hits not ready yet */ }
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
      expect([...names].sort()).toEqual([...expectedNames(preset, count)].sort());
      if (preset !== "mixed") {
        await expect(page.getByRole("tooltip")).toContainText(STATE_WORDS[preset]);
      }
      expect(errors).toEqual([]);
    });
  }
}

for (const count of COUNTS) {
  test(`ended x ${count} empties the kitchen onto the 86 board`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?preset=ended&agents=${count}`);
    // All records are 86'd, so the truthful mode treatment is the empty pill.
    await expect(page.getByRole("status").filter({ hasText: "Waiting for agents" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Dinner" })).toHaveAttribute("aria-pressed", "true");
});

test("idle cooks expose all four stable decorative poses", async ({ page }) => {
  await page.goto("/?preset=idle&agents=6&stats");
  await expect(placard(page)).toBeVisible();
  const readPoses = () => page.evaluate(() => {
    const metrics = (window as typeof window & { __miseSceneMetrics?: () => { idlePoses: Record<string, string> } }).__miseSceneMetrics?.();
    return metrics?.idlePoses ?? {};
  });
  await expect.poll(async () => Object.keys(await readPoses()).length).toBe(6);
  const first = await readPoses();
  expect(new Set(Object.values(first))).toEqual(new Set(["smoke", "recline", "sleep", "prep"]));
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

test("HMR socket delegates to native WebSocket and feed stays live past the stale timeout", async ({ page }) => {
  const errors = watchErrors(page);
  const viteMessages: string[] = [];
  page.on("console", message => { if (message.text().includes("[vite]")) viteMessages.push(message.text()); });
  await page.goto("/?preset=working&agents=6");
  await expect(placard(page)).toBeVisible();
  // Vite's HMR client connects over a non-/ws WebSocket; it only succeeds if
  // the visual override delegated to the captured native constructor.
  await expect.poll(() => viteMessages.some(text => text.includes("connected")), { timeout: 10_000 }).toBe(true);
  // The client marks the feed disconnected after 2.9s without frames; mock
  // heartbeats every 2s must keep it alive well past that.
  await page.waitForTimeout(6_500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(placard(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test("semantic station controls are AX-only Tab exclusions and restore focus after details close", async ({ page }) => {
  await page.goto("/?preset=working&agents=2");
  const station = page.getByRole("button", { name: "mise-01, Working — on the fire, open details" });
  await expect(station).toHaveAttribute("tabindex", "-1");
  await station.evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.getByRole("complementary", { name: "mise-01 details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "mise-01 details" })).toHaveCount(0);
  await expect(station).toBeFocused();
});

test("settings restores focus to its visible trigger", async ({ page }) => {
  await page.goto("/?preset=working&agents=1");
  const trigger = page.getByRole("button", { name: "Open settings" });
  await trigger.click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(trigger).toBeFocused();
});
