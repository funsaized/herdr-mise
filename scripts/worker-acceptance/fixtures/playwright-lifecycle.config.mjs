// Actual @playwright/test config for the #304 lifecycle acceptance. The single
// browser-free project runs against the fixture webServer; reuseExistingServer
// stays false so a surviving server from a prior run fails the second run.
import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const port = Number(process.env.NS_PW_PORT);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("NS_PW_PORT must name a valid TCP port");
}
const origin = `http://127.0.0.1:${port}`;
const server = fileURLToPath(
  new URL("./playwright-lifecycle-server.mjs", import.meta.url),
);

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "playwright-lifecycle.spec.mjs",
  timeout: 150_000,
  retries: 0,
  workers: 1,
  outputDir: process.env.NS_PW_OUTPUT_DIR,
  reporter: [["line"]],
  use: { baseURL: origin, headless: true },
  webServer: {
    command: `"${process.execPath}" "${server}"`,
    url: `${origin}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
