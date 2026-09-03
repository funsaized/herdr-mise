import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) =>
    console.error(`browser_pageerror=${error.message}`),
  );
  const started = performance.now();
  await page.goto(
    `http://127.0.0.1:${process.env.HERDR_MISE_PORT ?? "8686"}/`,
    {
      waitUntil: "domcontentloaded",
    },
  );
  await page.locator("canvas").waitFor({ state: "visible", timeout: 1500 });
  try {
    await page
      .getByText("DEMO SERVICE")
      .waitFor({ state: "visible", timeout: 5000 });
  } catch (error) {
    console.error(
      `browser_body=${(await page.locator("body").innerText()).replaceAll("\n", " | ")}`,
    );
    throw error;
  }
  const loadedFonts = await page.evaluate(async () => [
    (await document.fonts.load('16px "Instrument Sans"')).length,
    // oxfmt-ignore
    (await document.fonts.load('16px Silkscreen')).length,
  ]);
  if (loadedFonts.some((count) => count === 0)) {
    throw new Error(`bundled fonts did not load: ${loadedFonts.join(",")}`);
  }
  const elapsed = performance.now() - started;
  if (elapsed > 1500)
    throw new Error(`page readiness ${elapsed.toFixed(1)} ms exceeds 1500 ms`);
  console.log(`browser_ready_ms=${elapsed.toFixed(1)}`);
} finally {
  await browser.close();
}
