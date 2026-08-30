import { defineConfig } from "@playwright/test";
const hostedVisualUrl = process.env.HOSTED_VISUAL_URL;
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: hostedVisualUrl ?? "http://127.0.0.1:4174",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: hostedVisualUrl
    ? undefined
    : {
        command:
          "npm --prefix client run build -- --mode visual && npm --prefix client run preview -- --host 127.0.0.1 --port 4174 --strictPort --outDir dist-visual",
        cwd: "..",
        url: "http://127.0.0.1:4174",
        reuseExistingServer: false,
        timeout: 30_000,
      },
  reporter: [["line"]],
  outputDir: "artifacts/results",
});
