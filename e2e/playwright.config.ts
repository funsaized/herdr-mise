import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4174",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm --prefix client run dev:visual -- --host 127.0.0.1 --port 4174 --strictPort",
    cwd: "..",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  reporter: [["line"]],
  outputDir: "artifacts/results",
});
