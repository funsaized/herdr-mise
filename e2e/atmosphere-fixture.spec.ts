import { expect, test } from "@playwright/test";
import snapshot from "../protocol/fixtures/snapshot.v1.json";

type SceneMetrics = {
  motion: { activeParticles: number; reduced: boolean };
};

const sceneMetrics = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    (
      window as typeof window & {
        __miseSceneMetrics(): SceneMetrics;
      }
    ).__miseSceneMetrics(),
  );

test("fixture steam follows atmosphere, motion, visibility, and connection", async ({
  page,
}) => {
  expect(snapshot.agents.map(({ id, state }) => ({ id, state }))).toEqual([
    { id: "agent-01", state: "working" },
    { id: "agent-02", state: "idle" },
  ]);

  await page.goto("/?fixture=snapshot.v1&stats");
  await expect(
    page.getByRole("button", {
      name: "refactor-agent, Working — on the fire, open details",
    }),
  ).toHaveCount(1);
  await expect
    .poll(async () => (await sceneMetrics(page)).motion.activeParticles)
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Open settings" }).click();
  const atmosphere = page.getByRole("switch", {
    name: "Kitchen atmosphere",
  });
  await atmosphere.click();
  await expect
    .poll(async () => (await sceneMetrics(page)).motion.activeParticles)
    .toBe(0);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("herdr-mise:settings") ?? "null"),
    ),
  ).toMatchObject({ settings: { atmosphere: false } });

  await page.reload();
  await expect
    .poll(async () => (await sceneMetrics(page)).motion.activeParticles)
    .toBe(0);
  await page.getByRole("button", { name: "Open settings" }).click();
  const persistedAtmosphere = page.getByRole("switch", {
    name: "Kitchen atmosphere",
  });
  await expect(persistedAtmosphere).not.toBeChecked();

  await persistedAtmosphere.click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(async () => sceneMetrics(page))
    .toMatchObject({
      motion: { activeParticles: 0, reduced: true },
    });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(async () => (await sceneMetrics(page)).motion.activeParticles)
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => (await sceneMetrics(page)).motion.activeParticles)
    .toBe(0);

  await page.evaluate(() => {
    delete (document as Document & { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => (await sceneMetrics(page)).motion.activeParticles)
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    (
      window as typeof window & { __misePauseHeartbeats(): void }
    ).__misePauseHeartbeats(),
  );
  await expect(page.getByRole("alert")).toContainText(
    "Lost connection to herdr",
    { timeout: 5_000 },
  );
  await expect
    .poll(async () => (await sceneMetrics(page)).motion.activeParticles)
    .toBe(0);
  await page.waitForTimeout(1_200);
  await expect(page.getByRole("alert")).toContainText(
    "Lost connection to herdr",
  );
  expect((await sceneMetrics(page)).motion.activeParticles).toBe(0);
});
