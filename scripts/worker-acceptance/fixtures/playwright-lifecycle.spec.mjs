// Browser-free spec: only the API `request` fixture is used, so no browser
// binary is launched. The first run holds here after marking readiness so the
// harness can interrupt with the fixture webServer still listening.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("fixture webServer responds without a browser", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.ok()).toBe(true);

  const marker = process.env.NS_PW_MARKER;
  if (marker) {
    writeFileSync(
      marker,
      JSON.stringify({
        ready: true,
        port: Number(process.env.NS_PW_PORT),
        workerPid: process.pid,
      }),
    );
  }

  if (process.env.NS_PW_HOLD === "1") {
    const holdMs = Number(process.env.NS_PW_HOLD_MS ?? "120000");
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
});
