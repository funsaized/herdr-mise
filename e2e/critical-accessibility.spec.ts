import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("failed to reserve a browser fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("coalesces the mixed blocked burst and keeps both stations discoverable", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-announcement-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    source = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-herdr-0.8.2-p20.json",
        ),
        "utf8",
      ),
    ),
    sockets = new Set<Socket>(),
    agents = [
      ["fixture-codex", "Codex", "working"],
      ["fixture-hermes", "Hermes", "working"],
      ["fixture-claude", "Claude", "idle"],
    ].map(([id, name, state], index) => ({
      ...source.agents[0],
      terminal_id: id,
      pane_id: `${id}-pane`,
      display_agent: name,
      agent_status: state,
      state_change_seq: index + 1,
      agent_session: { value: `${id}-session` },
    }));
  let snapshot = JSON.stringify({
    result: { snapshot: { ...source, agents } },
  });
  const fixtureServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\n")) return;
      const method = JSON.parse(request).method;
      if (method === "session.snapshot") socket.end(`${snapshot}\n`);
      else socket.write('{"result":{"type":"subscription_started"}}\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(socketPath, resolve);
  });
  const app = spawn("target/debug/herdr-mise", [], {
    env: {
      ...process.env,
      HERDR_MISE_PORT: String(port),
      HERDR_SOCKET_PATH: socketPath,
    },
    stdio: "ignore",
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(appUrl)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await page.goto(appUrl);
    await expect(
      page.getByRole("button", { name: /^Codex, Working —/ }),
    ).toBeAttached();
    await expect(
      page.getByRole("button", { name: /^Claude, Idle —/ }),
    ).toBeAttached();

    snapshot = JSON.stringify({
      result: {
        snapshot: {
          ...source,
          agents: [
            { ...agents[0], agent_status: "blocked", state_change_seq: 4 },
            { ...agents[1], agent_status: "blocked", state_change_seq: 5 },
            { ...agents[2], agent_status: "working", state_change_seq: 6 },
          ],
        },
      },
    });
    const liveRegion = page.getByLabel("Agent state announcements");
    await expect(liveRegion).toHaveAttribute("aria-live", "polite");
    await expect(liveRegion).toHaveAttribute("aria-atomic", "true");
    await expect(liveRegion).toHaveText(
      "2 agents blocked: Codex and Hermes. Use Agent stations to open details.",
      { timeout: 10_000 },
    );

    for (const name of ["Codex", "Hermes"])
      await expect(
        page.getByRole("button", {
          name: new RegExp(`^${name}, Blocked — .*open details$`),
        }),
      ).toBeAttached();
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocked summary agents and settings remain keyboard-accessible at 320 CSS pixels", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Reflow-width coverage equivalent to 1280px at 400% zoom; not an AT listening test.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/?preset=blocked&agents=12&stats");
  await expect(
    page.getByRole("status").filter({ hasText: "DEMO SERVICE" }),
  ).toBeVisible();
  const summary = page.getByRole("region", {
      name: "Observed service summary",
    }),
    summaryBox = (await summary.boundingBox())!;
  await expect(summary).toContainText("Blocked: 12");
  expect(summaryBox.x).toBeGreaterThanOrEqual(0);
  expect(summaryBox.x + summaryBox.width).toBeLessThanOrEqual(320);
  const nextBlocked = page.getByRole("button", { name: /Next blocked:/ });
  await expect(nextBlocked).toBeEnabled();
  expect(await nextBlocked.getAttribute("aria-live")).toBeNull();
  await nextBlocked.click();
  await expect(page.locator(".stationA11yMirror button:focus")).toHaveAttribute(
    "aria-label",
    /Blocked — .*open details/,
  );
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("ArrowLeft");
  const station = page.locator(".stationA11yMirror button:focus"),
    selectedAgentId = await station.getAttribute("data-agent-id");
  expect(selectedAgentId).not.toBeNull();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: /details$/ });
  await expect(panel).toBeVisible();
  const selectedBox = await page.evaluate(() => {
    const metrics = (
      window as typeof window & {
        __miseSceneMetrics?: () => {
          activeFocusBounds: Record<
            string,
            { x: number; y: number; width: number; height: number }
          >;
        };
      }
    ).__miseSceneMetrics?.();
    return Object.values(metrics?.activeFocusBounds ?? {})[0];
  });
  if (selectedBox) {
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.y).toBeGreaterThanOrEqual(
      selectedBox.y + selectedBox.height,
    );
  } else {
    await expect(
      page.getByRole("region", { name: "Agent status list" }),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(
    page.locator(`[data-agent-id="${selectedAgentId}"]`),
  ).toBeFocused();
  const settings = page.getByRole("button", { name: /settings/i }).first();
  await settings.focus();
  await page.keyboard.press("Enter");
  const settingsPanel = page.getByRole("complementary", { name: "Settings" });
  await expect(settingsPanel).toBeVisible();
  const movedSummaryBox = (await summary.boundingBox())!,
    settingsBox = (await settingsPanel.boundingBox())!;
  expect(
    movedSummaryBox.y + movedSummaryBox.height <= settingsBox.y ||
      settingsBox.y + settingsBox.height <= movedSummaryBox.y,
  ).toBe(true);
  if (selectedBox) {
    expect(settingsBox.y).toBeGreaterThanOrEqual(
      selectedBox.y + selectedBox.height,
    );
  }
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("preview explorer controls remain operable at 320 by 320 CSS pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 320 });
  await page.goto("/?preset=mixed&agents=6");
  const explorer = page.getByRole("complementary", {
      name: "Preview explorer",
    }),
    details = explorer.locator("details"),
    summary = explorer.getByText("Preview explorer", { exact: true });
  const pagerNext = page.getByRole("button", { name: "Next", exact: true }),
    summaryBox = (await summary.boundingBox())!;
  if (await pagerNext.count()) {
    const pagerNextBox = (await pagerNext.boundingBox())!;
    expect(
      summaryBox.x < pagerNextBox.x + pagerNextBox.width &&
        summaryBox.x + summaryBox.width > pagerNextBox.x &&
        summaryBox.y < pagerNextBox.y + pagerNextBox.height &&
        summaryBox.y + summaryBox.height > pagerNextBox.y,
    ).toBe(false);
  }
  await summary.focus();
  expect(
    await summary.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  const scene = explorer.getByRole("combobox", { name: "Scene" });
  await scene.focus();
  await expect(scene).toBeFocused();
  expect(
    await scene.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  await page.keyboard.press("b");
  await expect(scene).toHaveValue("blocked");
  const cooks = explorer.getByRole("combobox", { name: "Cooks" });
  await cooks.focus();
  await page.keyboard.press("0");
  await expect(cooks).toHaveValue("0");
  await expect(explorer.getByRole("button", { name: "Replay" })).toBeVisible();
  const links = explorer.getByRole("link");
  await expect(links).toHaveCount(2);
  await page.setViewportSize({ width: 1280, height: 720 });
  for (const control of await explorer
    .locator("summary, select, button, a")
    .all()) {
    const controlBox = (await control.boundingBox())!;
    expect(controlBox.width).toBeGreaterThanOrEqual(44);
    expect(controlBox.height).toBeGreaterThanOrEqual(44);
  }
  for (const button of await page.locator(".visualTuiControls button").all())
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 640, height: 720 });
  expect((await explorer.boundingBox())!.width).toBeGreaterThanOrEqual(320);
  await page.setViewportSize({ width: 320, height: 320 });
  const box = (await explorer.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(320);
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(details).not.toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
  if (await pagerNext.count()) {
    await pagerNext.click();
    await expect(page.getByText(/Page 2 of/)).toBeVisible();
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(explorer).toHaveCount(0);
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(explorer).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("complementary", { name: /(?:details|session summary)$/ }),
  ).toBeVisible();
  await expect(explorer).toHaveCount(0);
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(explorer).toBeVisible();
});

test("renderer failure keeps a visible operable agent list", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      ...args: Parameters<typeof original>
    ) {
      if (String(args[0]).includes("webgl")) return null;
      return Reflect.apply(original, this, args);
    } as typeof original;
  });
  await page.goto("/?preset=blocked&agents=1");
  const fallback = page.getByRole("region", { name: "Agent status list" });
  await expect(fallback).toBeVisible();
  await expect(fallback.getByRole("alert")).toContainText(
    "graphics could not start",
  );
  await fallback.getByRole("button").first().click();
  await expect(
    page.getByRole("complementary", { name: /details$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(fallback.getByRole("button").first()).toBeFocused();
  expect(errors).toEqual([]);
});

test("workspace scope reveals blocked agents by keyboard at 320 CSS pixels", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/?preset=mixed&agents=2");
  const selector = page.getByRole("combobox", { name: "Workspace" });
  await expect(selector).toHaveValue("");
  await selector.selectOption("visual-workspace-1");
  const showAll = page.getByRole("button", {
    name: "1 blocked elsewhere — Show all",
  });
  await expect(showAll).toBeVisible();
  const showAllBox = await showAll.boundingBox();
  expect(showAllBox).not.toBeNull();
  if (
    !(await page.getByRole("region", { name: "Agent status list" }).isVisible())
  ) {
    const placardBox = await page.locator(".demoPlacard").boundingBox();
    expect(placardBox).not.toBeNull();
    expect(showAllBox!.y + showAllBox!.height).toBeLessThanOrEqual(
      placardBox!.y,
    );
  }
  await showAll.focus();
  await page.keyboard.press("Enter");
  await expect(selector).toBeFocused();
  await selector.selectOption("visual-workspace-1");
  await selector.focus();
  await page.keyboard.press("Tab");
  await expect(showAll).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(selector).toBeFocused();
  await expect(selector).toHaveValue("");
  await expect(
    page.getByRole("button", { name: /Claude, Blocked — .*open details/ }),
  ).toBeAttached();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
