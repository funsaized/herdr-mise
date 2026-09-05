import { defineConfig } from "@playwright/test";
const hostedVisualUrl = process.env.HOSTED_VISUAL_URL;
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: 0,
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    ...(process.env.HERDR_MISE_CROSS_BROWSER === "1"
      ? [
          {
            name: "firefox",
            use: { browserName: "firefox" as const },
            testMatch: "**/critical-accessibility.spec.ts",
          },
          {
            name: "webkit",
            use: { browserName: "webkit" as const },
            testMatch: "**/critical-accessibility.spec.ts",
          },
        ]
      : []),
  ],
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
          (process.env.HERDR_MISE_PREBUILT === "1"
            ? ""
            : "npm --prefix client run build && ") +
          "cargo build --locked --bin herdr-mise && npm --prefix client run build -- --mode visual && npm --prefix client run preview -- --host 127.0.0.1 --port 4174 --strictPort --outDir dist-visual",
        cwd: "..",
        url: "http://127.0.0.1:4174",
        reuseExistingServer: false,
        timeout: 120_000,
      },
  reporter: [["line"]],
  outputDir: "artifacts/results",
});
