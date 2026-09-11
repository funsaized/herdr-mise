import { expect, test } from "@playwright/test";

const hostedVisualUrl = process.env.HOSTED_VISUAL_URL;

test.skip(!hostedVisualUrl, "HOSTED_VISUAL_URL is required");

test("hosted visual demo serves static assets without localhost sockets", async ({
  page,
  request,
}) => {
  const sockets: string[] = [],
    escapedRequests: string[] = [],
    hostedOrigin = new URL(hostedVisualUrl!).origin;
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== hostedOrigin)
      escapedRequests.push(request.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("status").filter({ hasText: "DEMO SERVICE" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Intentional preview — deterministic mock feed. Nothing here is real.",
  );
  const explorer = page.getByRole("complementary", {
    name: "Preview explorer",
  });
  await expect(explorer).toBeVisible();
  await explorer.getByText("Preview explorer", { exact: true }).click();
  await expect(explorer.getByRole("link", { name: "Source" })).toHaveAttribute(
    "href",
    "https://github.com/funsaized/herdr-mise",
  );
  await expect(
    explorer.getByRole("link", { name: "Install for Herdr" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/funsaized/herdr-mise#quick-start",
  );
  await expect(
    page.getByRole("button", {
      name: "Codex, Working — on the fire, open details",
    }),
  ).toHaveCount(1);
  expect((await request.get("/tui-demo.gif")).status()).toBe(200);
  expect((await request.get("/tui-demo-poster.png")).status()).toBe(200);
  expect((await request.get("/og.png")).status()).toBe(200);
  await explorer
    .getByRole("combobox", { name: "Scene" })
    .selectOption("blocked");
  await explorer.getByRole("button", { name: "Load preview" }).click();
  await expect(
    page.locator('.stationA11yMirror button[aria-label*="Blocked —"]'),
  ).toHaveCount(6);
  await explorer.getByText("Preview explorer", { exact: true }).click();
  await explorer.getByRole("combobox", { name: "Cooks" }).selectOption("0");
  await explorer.getByRole("button", { name: "Load preview" }).click();
  await expect(page).toHaveURL(/[?&]agents=0(?:&|$)/);
  await expect(page.locator(".stationA11yMirror button")).toHaveCount(0);
  await explorer.getByText("Preview explorer", { exact: true }).click();
  await explorer.getByRole("combobox", { name: "Scene" }).selectOption("mixed");
  await explorer.getByRole("combobox", { name: "Cooks" }).selectOption("12");
  await explorer.getByRole("button", { name: "Load preview" }).click();
  await expect(page.locator(".stationA11yMirror button")).toHaveCount(12);
  await explorer.getByText("Preview explorer", { exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: /^Codex, Blocked — .*open details$/,
    }),
  ).toHaveCount(1, { timeout: 7_000 });
  const currentUrl = page.url();
  await Promise.all([
    page.waitForNavigation(),
    explorer.getByRole("button", { name: "Replay" }).click(),
  ]);
  expect(page.url()).toBe(currentUrl);
  await expect(
    page.getByRole("button", {
      name: "Codex, Working — on the fire, open details",
    }),
  ).toHaveCount(1);
  await page.waitForTimeout(3_500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(sockets).toEqual([]);
  expect(escapedRequests).toEqual([]);
});
