import { defineConfig } from "@playwright/test";
import { visualOrigin, visualPort } from "./visual-origin";
const hostedVisualUrl = process.env.HOSTED_VISUAL_URL;
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: 0,
  // Managed verification sets "100%": by the time browser tests run, the
  // runner's other lanes are finishing, so Playwright's 50% default idles cores.
  workers: process.env.HERDR_MISE_PLAYWRIGHT_WORKERS || undefined,
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    ...(process.env.HERDR_MISE_CROSS_BROWSER === "1"
      ? [
          {
            name: "firefox",
            use: {
              browserName: "firefox" as const,
              firefoxUserPrefs: {
                "webgl.force-enabled": true,
                "webgl.disabled": false,
              },
            },
            testMatch: "**/critical-accessibility.spec.ts",
          },
          ...(process.env.HERDR_MISE_SKIP_WEBKIT === "1"
            ? []
            : [
                {
                  name: "webkit",
                  use: { browserName: "webkit" as const },
                  testMatch: "**/critical-accessibility.spec.ts",
                },
              ]),
        ]
      : []),
  ],
  use: {
    baseURL: hostedVisualUrl ?? visualOrigin,
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
          `cargo build --locked --bin herdr-mise && npm --prefix client run build -- --mode visual && npm --prefix client run preview -- --host 127.0.0.1 --port ${visualPort} --strictPort --outDir dist-visual`,
        cwd: "..",
        url: visualOrigin,
        reuseExistingServer: false,
        timeout: 120_000,
      },
  reporter: [["line"]],
  outputDir: "artifacts/results",
});
