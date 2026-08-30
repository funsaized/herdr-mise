import { expect, test } from "@playwright/test";

const hostedVisualUrl = process.env.HOSTED_VISUAL_URL;

test.skip(!hostedVisualUrl, "HOSTED_VISUAL_URL is required");

test("hosted visual demo serves static assets without localhost sockets", async ({
  page,
  request,
}) => {
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.goto("/");
  await expect(
    page.getByRole("status").filter({ hasText: "DEMO SERVICE" }),
  ).toBeVisible();
  expect((await request.get("/tui-demo.gif")).status()).toBe(200);
  expect((await request.get("/og.png")).status()).toBe(200);
  expect(sockets.filter((url) => new URL(url).port === "8686")).toEqual([]);
});
