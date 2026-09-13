import { defineConfig } from "@playwright/test";
const endurance = process.env.HERDR_MISE_ENDURANCE === "1",
  durationMinutes = Number(
    process.env.HERDR_MISE_ENDURANCE_DURATION_MINUTES ?? "480",
  );
export default defineConfig({
  testDir: ".",
  testMatch: endurance ? "endurance.perf.spec.ts" : "client.perf.spec.ts",
  timeout: endurance ? durationMinutes * 60_000 + 300_000 : 60_000,
  workers: endurance ? 1 : undefined,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: !endurance,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--use-angle=metal"] },
  },
  webServer: endurance
    ? undefined
    : {
        command: "npm --prefix client run preview -- --host 127.0.0.1",
        cwd: "..",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: false,
        timeout: 30_000,
      },
  reporter: [
    ["line"],
    ["html", { outputFolder: "artifacts/report", open: "never" }],
  ],
  outputDir: "artifacts/results",
});
