import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeLayout,
  reconcileStationSlots,
} from "../client/src/scene/layout";
import { startFixtureApp } from "./fixture-app";
import {
  sceneMetrics,
  availablePort,
  boxesIntersect,
  expectInside,
  cycleSceneFocus,
  assertResponsiveScene,
} from "./visual-helpers";

test("protocol 21 and 22 fixtures reach browser through the live Feed", async ({
  page,
}) => {
  const readSnapshot = async (name: string) =>
      JSON.parse(
        await readFile(
          join(process.cwd(), "server/tests/fixtures", name),
          "utf8",
        ),
      ),
    protocol21 = await readSnapshot("snapshot-herdr-0.8.2-p21.json"),
    protocol22 = await readSnapshot("snapshot-herdr-0.9.0-p22.json"),
    fixture = await startFixtureApp({
      prefix: "herdr-mise-protocol-21-22-",
      snapshot: protocol21,
    });
  try {
    await page.goto(fixture.appUrl);
    await expect(
      page.getByRole("button", { name: /example-baker, Working/ }),
    ).toBeAttached();
    await expect(
      page.getByRole("combobox", { name: "Workspace" }),
    ).toContainText("Example Galley");
    await page
      .getByRole("button", { name: /example-baker, Working/ })
      .evaluate((element) => (element as HTMLButtonElement).click());
    await expect(
      page.getByRole("complementary", { name: "example-baker details" }),
    ).toContainText("fictional-pane-21");
    fixture.setSnapshot(protocol22);
    await expect(
      page.getByRole("button", { name: /example-reviewer, Blocked/ }),
    ).toBeAttached({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: /example-baker, Working/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Workspace" }),
    ).toContainText("Example Pastry");
    await page
      .getByRole("button", { name: /example-reviewer, Blocked/ })
      .evaluate((element) => (element as HTMLButtonElement).click());
    await expect(
      page.getByRole("complementary", { name: "example-reviewer details" }),
    ).toContainText("fictional-pane-22");
  } finally {
    await fixture.close();
  }
});

test("workspace scope follows stable identity without hiding blocked attention", async ({
  page,
}) => {
  const initial = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-workspace-scope.json",
        ),
        "utf8",
      ),
    ),
    fixture = await startFixtureApp({
      prefix: "herdr-mise-workspace-scope-",
      snapshot: initial,
    });
  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`${fixture.appUrl}/?stats`);
    const selector = page.getByRole("combobox", { name: "Workspace" });
    await expect(selector).toHaveValue("");
    await expect(page.getByRole("option")).toHaveText([
      "All",
      "empty",
      "duplicate (aceone)",
      "duplicate (acetwo)",
    ]);
    await expect(
      page.getByRole("button", { name: /scope-working, Working/ }),
    ).toBeAttached();
    await expect(
      page.getByRole("button", { name: /scope-blocked, Blocked/ }),
    ).toBeAttached();
    await expect
      .poll(async () =>
        Object.keys((await sceneMetrics(page))?.stationCells ?? {}),
      )
      .toEqual(["scope-terminal-one"]);

    await selector.selectOption("scope-workspace-one");
    await expect(
      page.getByRole("button", { name: /scope-blocked, Blocked/ }),
    ).toHaveCount(0);
    await expect
      .poll(async () => {
        const metrics = await sceneMetrics(page);
        return [
          Object.keys(metrics?.stationCells ?? {}),
          metrics?.escalationBlockedAgents,
        ];
      })
      .toEqual([["scope-terminal-one"], 1]);
    const showAll = page.getByRole("button", {
      name: "1 blocked elsewhere — Show all",
    });
    const selectorBox = (await selector.boundingBox())!,
      showAllBox = (await showAll.boundingBox())!;
    expect(selectorBox.height).toBeGreaterThanOrEqual(44);
    expect(showAllBox.height).toBeGreaterThanOrEqual(44);
    await selector.focus();
    await page.keyboard.press("Tab");
    await expect(showAll).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(selector).toBeFocused();
    await expect(selector).toHaveValue("");
    await expect(
      page.getByRole("button", { name: /scope-blocked, Blocked/ }),
    ).toBeAttached();

    await selector.selectOption("scope-workspace-one");
    const renamed = structuredClone(initial);
    renamed.workspaces[0].label = "renamed";
    fixture.setSnapshot(renamed);
    await expect(selector).toHaveValue("scope-workspace-one");
    await expect(page.getByRole("option", { name: "renamed" })).toBeAttached({
      timeout: 10_000,
    });

    const removed = structuredClone(renamed);
    removed.workspaces = [
      removed.workspaces[1],
      removed.workspaces[2],
      { workspace_id: "scope-workspace-new", label: "renamed" },
    ];
    removed.agents = [
      removed.agents[1],
      {
        terminal_id: "scope-terminal-new",
        pane_id: "scope-pane-new",
        workspace_id: "scope-workspace-new",
        display_agent: "scope-new",
        agent_status: "working",
      },
    ];
    fixture.setSnapshot(removed);
    await expect(selector).toHaveValue("scope-workspace-one", {
      timeout: 10_000,
    });
    const unavailable = page
      .getByRole("status")
      .filter({ hasText: "renamed is unavailable" });
    await expect(unavailable).toBeVisible();
    await expect(
      page.getByRole("button", { name: /scope-new, Working/ }),
    ).toHaveCount(0);
    await expect(showAll).toBeVisible();
    const scopeBox = await page.locator(".workspaceScope").boundingBox(),
      unavailableBox = await unavailable.boundingBox();
    expect(scopeBox).not.toBeNull();
    expect(unavailableBox).not.toBeNull();
    expectInside(scopeBox!, { x: 0, y: 0, width: 320, height: 640 });
    expectInside(unavailableBox!, { x: 0, y: 0, width: 320, height: 640 });
    expect(boxesIntersect(scopeBox!, unavailableBox!)).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("authoritative fixture drives rendered feed history accents poses prep and freezer spirits", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const observationClock = Date.now();
  await page.clock.setFixedTime(observationClock);
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-freezer-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    baseline = JSON.stringify(
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "server/tests/fixtures/snapshot-herdr-0.8.2-p20.json",
          ),
          "utf8",
        ),
      ),
    ),
    advanced = JSON.stringify(
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "server/tests/fixtures/snapshot-herdr-0.8.2-p20-state-sequence-advanced.json",
          ),
          "utf8",
        ),
      ),
    ),
    working = JSON.stringify(
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "server/tests/fixtures/snapshot-working-idle-accents.json",
          ),
          "utf8",
        ),
      ),
    ),
    blocked = JSON.stringify({
      result: {
        snapshot: JSON.parse(
          await readFile(
            join(
              process.cwd(),
              "server/tests/fixtures/snapshot-herdr-0.8.0-p19.json",
            ),
            "utf8",
          ),
        ),
      },
    }),
    empty = JSON.stringify(
      JSON.parse(
        await readFile(
          join(
            process.cwd(),
            "server/tests/fixtures/snapshot-protocol-19-empty-agents.json",
          ),
          "utf8",
        ),
      ),
    ),
    sockets = new Set<Socket>(),
    escapedRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== appUrl)
      escapedRequests.push(request.url());
  });
  let snapshot = baseline;
  const fixtureServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\n")) return;
      const method = JSON.parse(request).method;
      if (method === "session.snapshot") socket.end(`${snapshot.trim()}\n`);
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
    await page.goto(`${appUrl}/?stats`);
    await expect(
      page.getByRole("complementary", { name: "Preview explorer" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /Install for Herdr|Source/ }),
    ).toHaveCount(0);
    expect(escapedRequests).toEqual([]);
    const sequenceStation = page.getByRole("button", {
      name: "example-cook, Working — on the fire, open details",
    });
    await expect(sequenceStation).toBeAttached();
    await sequenceStation.evaluate((element) =>
      (element as HTMLButtonElement).click(),
    );
    const sequenceDetails = page.getByRole("complementary", {
        name: "example-cook details",
      }),
      stateAge = sequenceDetails
        .locator(".fact", { hasText: "Observation age" })
        .locator("b"),
      periods = sequenceDetails.getByRole("list", {
        name: "Mise observation history",
      });
    await page.clock.setFixedTime(observationClock + 3_000);
    await expect.poll(() => stateAge.textContent()).toMatch(/^[2-9]\d*s$/);
    await expect(periods.getByRole("listitem")).toHaveCount(1);
    snapshot = advanced;
    await expect(periods.getByRole("listitem")).toHaveCount(2);
    await expect(
      periods.getByRole("listitem", { name: /Working — on the fire period/ }),
    ).toHaveCount(2);
    await expect(
      periods.getByRole("listitem", { name: /Blocked/ }),
    ).toHaveCount(0);
    await expect(stateAge).toHaveText("0s");
    // Observation reset is exact under a fixed wall clock, independent of CI
    // scheduling. Resume real time for the subsequent animation assertions.
    await page.clock.setSystemTime(
      Math.max(Date.now(), observationClock + 3_000),
    );
    expect(
      await periods.evaluate((element) => getComputedStyle(element).columnGap),
    ).toBe("2px");
    await page.getByRole("button", { name: "Close panel" }).click();
    snapshot = working;
    await expect(
      page.getByRole("button", {
        name: "fixture-working, Working — on the fire, open details",
      }),
    ).toBeAttached();
    await expect(
      page.getByRole("button", {
        name: "fixture-idle, Idle — prepping, open details",
      }),
    ).toBeAttached();
    await expect
      .poll(async () => (await sceneMetrics(page))?.stationVisuals["t-11"])
      .toMatchObject({ accent: "#6f8a9a", idlePose: null });
    await expect
      .poll(async () => (await sceneMetrics(page))?.motion.activeParticles)
      .toBeGreaterThan(0);
    const workingRenderCount = (await sceneMetrics(page))!.renderCount;
    await page.waitForTimeout(300);
    expect((await sceneMetrics(page))!.renderCount).toBeGreaterThan(
      workingRenderCount,
    );
    expect((await sceneMetrics(page))?.atmosphere.workingContact).toBe(1);
    expect(
      (await sceneMetrics(page))?.motion.activeParticles,
    ).toBeLessThanOrEqual(48);
    const workingTruth = await sceneMetrics(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        atmosphere: {
          window: 0,
          shelf: 0,
          pass: 0,
          workingContact: 0,
          freezerAccents: 0,
        },
        motion: { activeParticles: 0 },
      });
    const atmosphereOff = await sceneMetrics(page);
    expect(atmosphereOff?.stationCells).toEqual(workingTruth?.stationCells);
    expect(atmosphereOff?.stationNameBounds).toEqual(
      workingTruth?.stationNameBounds,
    );
    expect(atmosphereOff?.stationStatusBounds).toEqual(
      workingTruth?.stationStatusBounds,
    );
    expect(atmosphereOff?.stateIndicators).toEqual(
      workingTruth?.stateIndicators,
    );
    expect(atmosphereOff?.board).toEqual(workingTruth?.board);
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => (await sceneMetrics(page))?.motion.activeParticles)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await sceneMetrics(page))?.stationVisuals["t-8"])
      .toMatchObject({ accent: "#a98a5b", prepStep: null });
    expect(
      (await sceneMetrics(page))?.stationVisuals["t-8"]?.idlePose,
    ).not.toMatch(/prep|smoke/i);
    const firstPrepStep = (await sceneMetrics(page))?.stationVisuals["t-11"]
      ?.prepStep;
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.stationVisuals["t-11"]?.prepStep !==
          firstPrepStep,
      )
      .toBe(true);
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await assertResponsiveScene(page, 2, false);
    }
    snapshot = blocked;
    await page.setViewportSize({ width: 390, height: 844 });
    const blockedStation = page.getByRole("button", {
      name: /example-reviewer, Blocked — at the pass.*open details/,
    });
    await expect(blockedStation).toBeAttached({ timeout: 10_000 });
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        stateIndicators: { blocked: 1 },
        atmosphere: { workingContact: 0 },
        motion: { activeParticles: 0 },
        stationVisuals: {
          "fictional-terminal-19": {
            accent: "#7a7f9e",
            idlePose: null,
            prepStep: null,
          },
        },
      });
    await page.locator(".canvasHost").evaluate((element) => {
      element.setAttribute("tabindex", "-1");
      (element as HTMLElement).focus();
    });
    await expect
      .poll(async () => {
        if (
          await blockedStation.evaluate((element) => element.matches(":focus"))
        )
          return true;
        await page.keyboard.press("ArrowRight");
        return blockedStation.evaluate((element) => element.matches(":focus"));
      })
      .toBe(true);
    await expect(blockedStation).toBeFocused();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveAttribute(
      "id",
      "station-tooltip-fictional-terminal-19",
    );
    await expect(blockedStation).toHaveAttribute(
      "aria-describedby",
      "station-tooltip-fictional-terminal-19",
    );
    const tooltipBox = await tooltip.boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press("Enter");
    const details = page.getByRole("complementary", {
        name: "example-reviewer details",
      }),
      primaryPanels = page.locator("aside.panel");
    await expect(details).toBeFocused();
    await expect(
      details.locator(".fact", { hasText: "Workspace" }).locator("b"),
    ).toHaveText("example-pantry");
    await expect(primaryPanels).toHaveCount(1);
    await expect(tooltip).toHaveCount(0);
    const selected = (await sceneMetrics(page))!.activeFocusBounds[
        "fictional-terminal-19"
      ]!,
      detailBox = await details.boundingBox();
    expect(
      (await sceneMetrics(page))!.activeFocusCornerSizes[
        "fictional-terminal-19"
      ],
    ).toBe(13.5);
    expect(detailBox).not.toBeNull();
    expectInside(detailBox!, { x: 0, y: 0, width: 390, height: 844 });
    expect(boxesIntersect(selected, detailBox!)).toBe(false);
    const settings = page.getByRole("button", { name: "Open settings" });
    await settings.focus();
    await page.keyboard.press("Enter");
    const settingsPanel = page.getByRole("complementary", { name: "Settings" });
    await expect(settingsPanel).toBeFocused();
    await expect(primaryPanels).toHaveCount(1);
    await expect(details).toHaveCount(0);
    const settingsBox = await settingsPanel.boundingBox();
    expect(settingsBox).not.toBeNull();
    expectInside(settingsBox!, { x: 0, y: 0, width: 390, height: 844 });
    expect(boxesIntersect(selected, settingsBox!)).toBe(false);
    await page.setViewportSize({ width: 320, height: 640 });
    const narrowSelected = (await sceneMetrics(page))!.activeFocusBounds[
        "fictional-terminal-19"
      ]!,
      narrowSettingsBox = await settingsPanel.boundingBox();
    expect(narrowSettingsBox).not.toBeNull();
    expectInside(narrowSettingsBox!, { x: 0, y: 0, width: 320, height: 640 });
    expect(boxesIntersect(narrowSelected, narrowSettingsBox!)).toBe(false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    await expect(details).toBeVisible();
    await expect(primaryPanels).toHaveCount(1);
    const narrowDetailBox = await details.boundingBox();
    expect(narrowDetailBox).not.toBeNull();
    expect(boxesIntersect(narrowSelected, narrowDetailBox!)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(blockedStation).toBeFocused();
    await expect(primaryPanels).toHaveCount(0);
    await page.mouse.click(
      narrowSelected.x + narrowSelected.width / 2,
      narrowSelected.y + narrowSelected.height / 2,
    );
    await expect(details).toBeVisible();
    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(blockedStation).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    snapshot = empty;
    await expect(
      page.getByRole("button", {
        name: "fixture-working, Working — on the fire, open details",
      }),
    ).toHaveCount(0);
    const boardButton = page
      .getByRole("navigation", { name: "Agent stations" })
      .getByRole("button", { name: /fixture-working, Ended/i });
    await expect(boardButton).toBeAttached();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        endedEntries: 4,
        atmosphere: { workingContact: 0 },
        motion: { activeParticles: 0 },
        board: {
          headers: ["COOK", "MISE TIME"],
          rows: [{}, {}, {}],
        },
      });
    await page.waitForTimeout(1_200);
    const emptyRenderCount = (await sceneMetrics(page))!.renderCount;
    await page.waitForTimeout(2_000);
    expect(
      (await sceneMetrics(page))!.renderCount - emptyRenderCount,
    ).toBeLessThanOrEqual(1);
    const rows = (await sceneMetrics(page))?.board.rows
      .map((row) => row.text)
      .sort(([left], [right]) => left!.localeCompare(right!));
    expect(rows?.map(([name]) => name)).toEqual([
      "EXAMPLE-REVIEWER",
      "FIXTURE-IDLE",
      "FIXTURE-WORKING",
    ]);
    for (const [, runtime] of rows ?? [])
      expect(runtime).toMatch(/^(?:—|\d+:\d{2})$/);
    await settings.click();
    const emptyStatus = page
      .getByRole("status")
      .filter({ hasText: "Waiting for agents" });
    await expect(settingsPanel).toBeVisible();
    await expect(emptyStatus).toBeVisible();
    const emptySettingsBox = await settingsPanel.boundingBox(),
      emptyStatusBox = await emptyStatus.boundingBox();
    expect(emptySettingsBox).not.toBeNull();
    expect(emptyStatusBox).not.toBeNull();
    expect(boxesIntersect(emptySettingsBox!, emptyStatusBox!)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    await boardButton.evaluate((element) =>
      (element as HTMLButtonElement).click(),
    );
    await expect(
      page.locator('aside[aria-label$="session summary" i]'),
    ).toBeVisible();
    await expect(primaryPanels).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Freezer" }).click();
    await expect(page.getByRole("button", { name: "Freezer" })).toHaveCSS(
      "background-color",
      "rgb(44, 39, 33)",
    );
    await expect(
      page.getByRole("navigation", { name: "Ended chefs" }).getByRole("button"),
    ).toHaveCount(4);
    await expect(page.getByLabel("Agent state announcements")).toHaveText(
      "Freezer, 4 decorative spirits, 4 inspectable sessions",
    );
    const newestEnded = page
      .getByRole("navigation", { name: "Ended chefs" })
      .getByRole("button")
      .first();
    await newestEnded.click();
    await expect(
      page.locator('aside[aria-label$="session summary" i]'),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(newestEnded).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Freezer" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await page.getByRole("button", { name: "Freezer" }).click();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        view: "freezer",
        endedEntries: 4,
        visibleSpirits: 4,
        atmosphere: { freezerAccents: 11 },
        motion: { activeParticles: 0 },
      });
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await expect
      .poll(async () => (await sceneMetrics(page))?.atmosphere)
      .toEqual({
        window: 0,
        shelf: 0,
        pass: 0,
        workingContact: 0,
        freezerAccents: 0,
      });
    expect(escapedRequests).toEqual([]);
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("real fixture service summary cycles every blocked cook without moving stations", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-summary-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    source = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-herdr-0.8.0-p19.json",
        ),
        "utf8",
      ),
    ),
    sockets = new Set<Socket>();
  let snapshot = "";
  const setRoster = (count: number, allBlocked = false) => {
      const states = allBlocked
        ? ["blocked"]
        : ["blocked", "working", "idle", "done"];
      snapshot = JSON.stringify({
        result: {
          snapshot: {
            ...source,
            agents: Array.from({ length: count }, (_, index) => ({
              ...source.agents[0],
              terminal_id: `fixture-terminal-${String(index).padStart(2, "0")}`,
              pane_id: `fixture-${String(index).padStart(2, "0")}`,
              display_agent: `Cook${String(index).padStart(2, "0")}`,
              agent_status: states[index % states.length],
              agent_session: { value: `fixture-session-${index}` },
            })),
          },
        },
      });
    },
    fixtureServer = createServer((socket) => {
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
  setRoster(4);
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
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`${appUrl}/?stats`);
    for (const count of [4, 16, 30]) {
      setRoster(count);
      const blockedCount = Math.ceil(count / 4),
        summary = page.getByRole("region", {
          name: "Observed service summary",
        });
      await expect(summary).toContainText(`Blocked: ${blockedCount}`, {
        timeout: 10_000,
      });
      await expect(summary).toContainText(`Shown: ${count} of ${count}`);
      await expect(summary).toContainText("Hidden plated: 0");
      await expect(summary).toContainText("Oldest blocked: Cook00");
      expect(await summary.locator("strong").allTextContents()).toEqual([
        "Observed -",
        "Working:",
        "Blocked:",
        "Plated:",
        "Unknown:",
        "Shown:",
        "Hidden plated:",
        "Oldest blocked:",
      ]);
      const initialMetrics = (await sceneMetrics(page))!;
      const summaryBox = (await summary.boundingBox())!,
        canvasBox = (await page.locator(".canvasHost").boundingBox())!;
      expect(canvasBox).toEqual({ x: 0, y: 0, width: 320, height: 640 });
      expect(
        Object.values(initialMetrics.stationStatusBounds).filter((status) =>
          boxesIntersect(summaryBox, status),
        ),
        `summary ${JSON.stringify(summaryBox)}; canvas ${JSON.stringify(canvasBox)}`,
      ).toEqual([]);
      expect(
        Object.keys(initialMetrics.blockedPlacements).length,
      ).toBeGreaterThan(0);
      expect(
        Object.keys(initialMetrics.blockedPlacements).length,
      ).toBeLessThanOrEqual(blockedCount);
      const stationBounds = Object.values(initialMetrics.stationCells),
        focused = new Set<string>();
      let firstFocused = "";
      for (let index = 0; index <= blockedCount; index++) {
        await page.keyboard.press("b");
        await expect
          .poll(async () =>
            Object.keys((await sceneMetrics(page))!.activeFocusBounds),
          )
          .toHaveLength(1);
        const focusedId = Object.keys(
          (await sceneMetrics(page))!.activeFocusBounds,
        )[0]!;
        if (index === 0) firstFocused = focusedId;
        else if (index === blockedCount) expect(focusedId).toBe(firstFocused);
        focused.add(focusedId);
      }
      expect(focused.size).toBe(blockedCount);
      expect(Object.values((await sceneMetrics(page))!.stationCells)).toEqual(
        stationBounds,
      );
    }
    setRoster(12, true);
    const summary = page.getByRole("region", {
      name: "Observed service summary",
    });
    await expect(summary).toContainText("Blocked: 12", { timeout: 10_000 });
    await expect
      .poll(
        async () =>
          Object.keys((await sceneMetrics(page))!.blockedPlacements).length,
      )
      .toBeGreaterThan(0);
    const summaryBox = (await summary.boundingBox())!,
      statusBounds = Object.values(
        (await sceneMetrics(page))!.stationStatusBounds,
      );
    expect(
      statusBounds.filter((status) => boxesIntersect(summaryBox, status)),
    ).toEqual([]);
    await page.getByRole("button", { name: "Freezer" }).click();
    await expect(
      page.getByRole("button", { name: /Next blocked:/ }),
    ).toBeDisabled();
    await page.keyboard.press("b");
    await expect
      .poll(async () => (await sceneMetrics(page))?.view)
      .toBe("freezer");
    await expect
      .poll(async () =>
        Object.keys((await sceneMetrics(page))!.activeFocusBounds),
      )
      .toHaveLength(0);
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture-backed repeated lifetimes survive cap eviction with source-id lookalikes", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-identity-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    kindFixture = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-working-idle-accents.json",
        ),
        "utf8",
      ),
    ),
    source = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-herdr-0.8.0-p19.json",
        ),
        "utf8",
      ),
    );
  source.workspaces = [
    {
      workspace_id: "one",
      label: "/work/料理/very-long-shared-workspace",
    },
    { workspace_id: "two", label: "/other/very-long-shared-workspace" },
  ];
  const locatorOne = "pane-with-a-very-long-shared-prefix-🥘-one",
    locatorTwo = "pane-with-a-very-long-shared-prefix-🥘-two";
  source.agents[0] = {
    ...source.agents[0],
    terminal_id: "terminal-one",
    pane_id: locatorOne,
    workspace_id: "one",
    name: "same chef",
    agent: kindFixture.result.snapshot.agents[0].agent,
  };
  source.agents.push({
    ...source.agents[0],
    terminal_id: "terminal-one:1",
    pane_id: locatorTwo,
    workspace_id: "two",
  });
  let snapshot = JSON.stringify({ result: { snapshot: source } });
  const sockets = new Set<Socket>(),
    fixtureServer = createServer((socket) => {
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
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: appUrl,
    });
    await page.setViewportSize({ width: 420, height: 640 });
    await page.goto(`${appUrl}/?stats`);
    const first = page.getByRole("button", {
      name: /same chef .*one, Blocked/,
    });
    await expect(first).toBeAttached();
    await expect(
      page.getByRole("button", {
        name: /same chef .*two, Blocked/,
      }),
    ).toBeAttached();
    await assertResponsiveScene(page, 2, false);
    const labels = Object.values((await sceneMetrics(page))!.stationNameBounds);
    expect(labels.every(({ text }) => Array.from(text).length <= 30)).toBe(
      true,
    );
    expect(labels.map(({ text }) => text.slice(-3)).sort()).toEqual([
      "one",
      "two",
    ]);
    await first.evaluate((button: HTMLButtonElement) => button.click());
    const details = page.getByLabel("same chef details");
    await expect(details).toContainText("very-long-shared-workspace");
    await expect(details).toContainText("codex");
    await expect(details).toContainText(locatorOne);
    const copyLocator = details.getByRole("button", { name: "Copy locator" });
    await expect(copyLocator).toHaveCSS("min-width", "44px");
    await expect(copyLocator).toHaveCSS("min-height", "44px");
    await copyLocator.click();
    await expect(details).toContainText("Locator copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      locatorOne,
    );

    const movedLocator = "pane-with-a-very-long-shared-prefix-🥘-moved";
    source.agents[0].pane_id = movedLocator;
    snapshot = JSON.stringify({ result: { snapshot: source } });
    await expect(details).toContainText(movedLocator, { timeout: 5_000 });
    await expect(details).toContainText("very-long-shared-workspace");

    const repeatedAgent = { ...source.agents[0] },
      lookalikeAgent = { ...source.agents[1] };
    source.agents = [];
    snapshot = JSON.stringify({ result: { snapshot: source } });
    await page.getByRole("button", { name: "Freezer" }).click();
    const ended = page.getByRole("navigation", { name: "Ended chefs" });
    await expect(ended.locator('[data-agent-id="terminal-one"]')).toBeAttached({
      timeout: 5_000,
    });
    await expect(
      ended.locator('[data-agent-id="terminal-one:1"]'),
    ).toBeAttached();

    await page.keyboard.press("Escape");
    const activeStations = page.getByRole("navigation", {
      name: "Agent stations",
    });
    for (const endedEntries of [3, 4]) {
      source.agents = [repeatedAgent];
      snapshot = JSON.stringify({ result: { snapshot: source } });
      await expect(
        activeStations.locator(
          '[data-agent-id="terminal-one"][aria-label*="Blocked"]',
        ),
      ).toBeAttached({ timeout: 5_000 });
      source.agents = [];
      snapshot = JSON.stringify({ result: { snapshot: source } });
      await expect
        .poll(async () => (await sceneMetrics(page))?.endedEntries)
        .toBe(endedEntries);
    }

    source.agents = [
      lookalikeAgent,
      ...Array.from({ length: 47 }, (_, index) => ({
        ...repeatedAgent,
        terminal_id: `retained-${index}`,
        pane_id: `retained-pane-${index}`,
        display_agent: `retained chef ${index}`,
      })),
    ];
    snapshot = JSON.stringify({ result: { snapshot: source } });
    await expect(
      activeStations.locator('button[aria-label*="Blocked"]'),
    ).toHaveCount(48, { timeout: 5_000 });
    source.agents = [];
    snapshot = JSON.stringify({ result: { snapshot: source } });
    await expect
      .poll(async () => (await sceneMetrics(page))?.endedEntries, {
        timeout: 10_000,
      })
      .toBe(50);

    await page.getByRole("button", { name: "Freezer" }).click();
    const retained = page
        .getByRole("navigation", { name: "Ended chefs" })
        .getByRole("button"),
      retainedIds = await retained.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("data-agent-id")),
      );
    expect(retainedIds).toHaveLength(50);
    expect(new Set(retainedIds).size).toBe(50);
    expect(retainedIds).not.toContain("terminal-one");
    expect(retainedIds).not.toContain("terminal-one:1");
    expect(retainedIds).toEqual(
      expect.arrayContaining([
        "terminal-one:2",
        "terminal-one:3",
        "terminal-one:1:1",
      ]),
    );
    await expect(page.getByLabel("Agent state announcements")).toContainText(
      "50 inspectable sessions",
    );
    await expect(page.getByLabel("Agent state announcements")).toContainText(
      "latest 50 retained",
    );
    const repeatedLifetime = ended.locator('[data-agent-id="terminal-one:2"]'),
      nextRepeatedLifetime = ended.locator('[data-agent-id="terminal-one:3"]');
    await repeatedLifetime.click();
    await expect(
      page.getByRole("complementary", { name: "same chef session summary" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(repeatedLifetime).toBeFocused();
    await nextRepeatedLifetime.click();
    await expect(
      page.getByRole("complementary", { name: "same chef session summary" }),
    ).toBeVisible();
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoritative fixture keeps live kitchen after done-timeout dismissal and reveal", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-done-clear-")),
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
    ) as {
      agents: Array<{
        terminal_id: string;
        pane_id: string;
        workspace_id: string;
        display_agent: string;
        agent_status: string;
        agent_session: { value: string };
      }>;
    },
    empty = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-protocol-19-empty-agents.json",
        ),
        "utf8",
      ),
    ),
    makeSnapshot = () => ({
      ...source,
      agents: Array.from({ length: 12 }, (_, index) => {
        const suffix = String(index + 1).padStart(2, "0");
        return {
          ...source.agents[0]!,
          terminal_id: `fictional-terminal-${suffix}`,
          pane_id: `fictional-pane-${suffix}`,
          display_agent: `example-cook-${suffix}`,
          agent_status: "working",
          agent_session: { value: `fictional-session-${suffix}` },
        };
      }),
    }),
    sockets = new Set<Socket>(),
    stations = page
      .getByRole("navigation", { name: "Agent stations" })
      .getByRole("button"),
    doneCook = page.getByRole("button", {
      name: /example-cook-01, Done — plated/,
    }),
    workingCook = page.getByRole("button", {
      name: /example-cook-01, Working — on the fire/,
    }),
    reveal = page.getByRole("button", {
      name: "1 plated cook cleared — reveal",
    }),
    emptyStatus = page
      .getByRole("status")
      .filter({ hasText: "Waiting for agents" }),
    announcements = page.getByLabel("Agent state announcements");
  let snapshot: object = makeSnapshot();
  const fixtureServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\n")) return;
      const method = JSON.parse(request).method;
      if (method === "session.snapshot")
        socket.end(`${JSON.stringify({ result: { snapshot } })}\n`);
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
    await page.addInitScript(() => {
      const nativeSetTimeout = window.setTimeout.bind(window),
        nativeClearTimeout = window.clearTimeout.bind(window),
        pending = new Map();
      let nextId = 1e9;
      window.setTimeout = (handler, timeout, ...args) => {
        if (timeout === 600000 && typeof handler === "function") {
          const id = nextId++;
          pending.set(id, () => {
            pending.delete(id);
            handler(...args);
          });
          return id;
        }
        return nativeSetTimeout(handler, timeout, ...args);
      };
      window.clearTimeout = (id) => {
        if (pending.delete(id)) return;
        nativeClearTimeout(id);
      };
      Object.defineProperty(window, "__miseFlushDoneTimeouts", {
        configurable: true,
        value: () => {
          for (const run of [...pending.values()]) run();
        },
      });
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${appUrl}/?stats`);
    await expect(stations).toHaveCount(12, { timeout: 10_000 });
    await expect(workingCook).toBeAttached();
    snapshot = structuredClone(snapshot);
    (
      snapshot as { agents: Array<{ agent_status: string }> }
    ).agents[0]!.agent_status = "done";
    await expect(doneCook).toBeAttached({ timeout: 10_000 });
    // Preserve real ordering: the 100ms state announcement precedes the
    // ten-minute dismissal timer that this fixture accelerates below.
    await expect(announcements).toHaveText("example-cook-01 done");
    await page.evaluate(() =>
      (
        window as typeof window & { __miseFlushDoneTimeouts?: () => void }
      ).__miseFlushDoneTimeouts?.(),
    );
    await expect(reveal).toBeVisible();
    await expect(emptyStatus).toHaveCount(0);
    await expect(stations).toHaveCount(11);
    await expect(doneCook).toHaveCount(0);
    await expect(announcements).toHaveText(
      "example-cook-01 cleared from the kitchen",
    );
    snapshot = structuredClone(snapshot);
    await page.waitForTimeout(1_500);
    await expect(reveal).toBeVisible();
    await expect(stations).toHaveCount(11);
    await expect(doneCook).toHaveCount(0);
    await expect(emptyStatus).toHaveCount(0);
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
      { width: 320, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(async () => {
          const metrics = await sceneMetrics(page),
            cells = Object.values(metrics?.stationCells ?? {});
          return (
            metrics?.page.totalCount === 11 &&
            cells.length === metrics.page.visibleIds.length &&
            cells.every((cell) => cell.width > 0)
          );
        })
        .toBe(true);
      const revealBox = (await reveal.boundingBox())!,
        workspaceBox = (await page.locator(".workspaceScope").boundingBox())!,
        pager = page.locator(".kitchenPager"),
        pagerBox = (await pager.count()) ? await pager.boundingBox() : null,
        settingsBox = (await page
          .getByRole("button", { name: "Open settings" })
          .boundingBox())!,
        freezerBox = (await page
          .getByRole("button", { name: "Freezer" })
          .boundingBox())!;
      expect(boxesIntersect(revealBox, workspaceBox)).toBe(false);
      if (pagerBox) expect(boxesIntersect(revealBox, pagerBox)).toBe(false);
      expect(boxesIntersect(revealBox, settingsBox)).toBe(false);
      expect(boxesIntersect(revealBox, freezerBox)).toBe(false);
      for (const cell of Object.values(
        (await sceneMetrics(page))!.stationCells,
      ))
        expect(boxesIntersect(revealBox, cell)).toBe(false);
    }
    await reveal.click();
    await expect(announcements).toHaveText("1 plated cook revealed");
    await expect(doneCook).toBeVisible();
    await expect(reveal).toHaveCount(0);
    snapshot = structuredClone(snapshot);
    (
      snapshot as { agents: Array<{ agent_status: string }> }
    ).agents[0]!.agent_status = "working";
    await expect(workingCook).toBeAttached({ timeout: 10_000 });
    await page.reload();
    await expect(stations).toHaveCount(12, { timeout: 10_000 });
    await expect(workingCook).toBeVisible();
    snapshot = empty;
    await expect(emptyStatus).toBeVisible({ timeout: 10_000 });
    await expect(reveal).toHaveCount(0);
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture-driven materials, slots, and readable dense kitchen", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const directory = await mkdtemp(
      join(tmpdir(), "herdr-mise-blocked-density-"),
    ),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    socketPath = join(directory, "herdr.sock"),
    source = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-herdr-0.8.0-p19.json",
        ),
        "utf8",
      ),
    ) as {
      agents: Array<{
        terminal_id: string;
        pane_id: string;
        workspace_id: string;
        display_agent: string;
        agent_status: string;
        agent_session: { value: string };
      }>;
    },
    makeSnapshotFromIds = (ids: readonly string[], status = "blocked") => ({
      ...source,
      agents: ids.map((id) => {
        return {
          ...source.agents[0]!,
          terminal_id: `fictional-terminal-${id}`,
          pane_id: `fictional-pane-${id}`,
          display_agent: id.startsWith("m") ? id : `density-${id}`,
          agent_status: status,
          agent_session: { value: `fictional-session-${id}` },
        };
      }),
    }),
    makeSnapshot = (count: number, status = "blocked") =>
      makeSnapshotFromIds(
        Array.from({ length: count }, (_, index) =>
          String(index + 1).padStart(2, "0"),
        ),
        status,
      ),
    sockets = new Set<Socket>();
  let snapshot = makeSnapshot(1, "working");
  const fixtureServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\n")) return;
      const method = JSON.parse(request).method;
      if (method === "session.snapshot")
        socket.end(`${JSON.stringify({ result: { snapshot } })}\n`);
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
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${appUrl}/?stats&theme=light`);
    const workingControl = page.getByRole("button", {
      name: /density-01, Working — on the fire/,
    });
    await expect(workingControl).toBeVisible();
    const workingOn = (await sceneMetrics(page))!;
    expect(workingOn.materials).toMatchObject({
      wallPlanes: 3,
      fixtureShadows: 4,
      passEdges: 3,
      stationGroundings: 1,
    });
    expect(workingOn.materials.floorSeams).toBeGreaterThan(0);
    expectInside(
      workingOn.stationNameBounds["fictional-terminal-01"]!,
      workingOn.stationCells["fictional-terminal-01"]!,
    );
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await expect
      .poll(async () => (await sceneMetrics(page))?.atmosphere)
      .toEqual({
        window: 0,
        shelf: 0,
        pass: 0,
        workingContact: 0,
        freezerAccents: 0,
      });
    expect((await sceneMetrics(page))?.materials).toEqual(workingOn.materials);

    await page.goto(`${appUrl}/?stats&theme=dinner`);
    await page.emulateMedia({ reducedMotion: "reduce" });

    const setLiveIds = async (ids: readonly string[]) => {
        snapshot = makeSnapshotFromIds(ids, "working");
        await expect
          .poll(async () =>
            Object.keys((await sceneMetrics(page))?.stationCells ?? {}),
          )
          .toEqual(
            expect.arrayContaining(ids.map((id) => `fictional-terminal-${id}`)),
          );
        await expect
          .poll(
            async () =>
              Object.keys((await sceneMetrics(page))?.stationCells ?? {})
                .length,
          )
          .toBe(ids.length);
        return (await sceneMetrics(page))!.stationCells;
      },
      expectSurvivorsStationary = (
        before: Record<
          string,
          { x: number; y: number; width: number; height: number }
        >,
        after: Record<
          string,
          { x: number; y: number; width: number; height: number }
        >,
      ) => {
        for (const id of Object.keys(before))
          if (id in after) expect(after[id]).toEqual(before[id]);
      };

    await setLiveIds([]);
    const four = await setLiveIds(["a01", "a02", "a03", "a04"]),
      five = await setLiveIds(["a01", "a02", "a03", "a04", "a05"]);
    expectSurvivorsStationary(four, five);
    const fourAgain = await setLiveIds(["a01", "a02", "a03", "a04"]);
    expectSurvivorsStationary(five, fourAgain);

    const hole = await setLiveIds(["a01", "a03", "a04"]),
      replacement = await setLiveIds(["a01", "a03", "a04", "a99"]);
    expect(replacement["fictional-terminal-a99"]).toEqual(
      five["fictional-terminal-a02"],
    );
    expectSurvivorsStationary(hole, replacement);
    const visualOrder = Object.entries(replacement)
      .sort(([, left], [, right]) => left.y - right.y || left.x - right.x)
      .map(([id]) => id);
    expect(visualOrder.slice(0, 2)).toEqual([
      "fictional-terminal-a01",
      "fictional-terminal-a99",
    ]);
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const replacementControl = page.getByRole("button", {
      name: /density-a99, Working/,
    });
    await expect(replacementControl).toBeFocused();
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.activeFocusBounds[
            "fictional-terminal-a99"
          ],
      )
      .toBeTruthy();
    expectInside(
      (await sceneMetrics(page))!.activeFocusBounds["fictional-terminal-a99"]!,
      replacement["fictional-terminal-a99"]!,
    );

    const eight = await setLiveIds([
        "b01",
        "b02",
        "b03",
        "b04",
        "b05",
        "b06",
        "b07",
        "b08",
      ]),
      nine = await setLiveIds([
        "b01",
        "b02",
        "b03",
        "b04",
        "b05",
        "b06",
        "b07",
        "b08",
        "b09",
      ]);
    expectSurvivorsStationary(eight, nine);
    expectSurvivorsStationary(
      nine,
      await setLiveIds([
        "b01",
        "b02",
        "b03",
        "b04",
        "b05",
        "b06",
        "b07",
        "b08",
      ]),
    );

    await setLiveIds(["c01", "c02", "c03", "c04", "c05", "c06"]);
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.keyboard.press("ArrowRight");
    const survivorControl = page.getByRole("button", {
      name: /density-c01, Working/,
    });
    await expect(survivorControl).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("complementary", { name: /density-c01 details/i }),
    ).toBeVisible();
    await setLiveIds(["c01", "c02", "c03", "c04", "c05", "c06", "c07"]);
    await expect(
      page.getByRole("complementary", { name: /density-c01 details/i }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.activeFocusBounds[
            "fictional-terminal-c01"
          ],
      )
      .toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(survivorControl).toBeFocused();

    await page.emulateMedia({ reducedMotion: "no-preference" });

    for (const count of [1, 4, 8, 16, 30, 60]) {
      for (const viewport of [
        { width: 1280, height: 720 },
        { width: 320, height: 640 },
        { width: 481, height: 360 },
        { width: 640, height: 360 },
      ]) {
        await page.setViewportSize(viewport);
        snapshot = makeSnapshotFromIds(
          Array.from(
            { length: count },
            (_, index) => `m${String(index + 1).padStart(2, "0")}`,
          ),
        );
        const buttons = page
          .getByRole("navigation", { name: "Agent stations" })
          .getByRole("button", { name: /Blocked —/ });
        await expect(buttons).toHaveCount(count, { timeout: 10_000 });
        await expect
          .poll(async () => {
            const metrics = await sceneMetrics(page);
            return metrics?.page.totalCount === count;
          })
          .toBe(true);
        const expected = computeLayout(
          viewport.width,
          viewport.height,
          reconcileStationSlots(
            [],
            Array.from(
              { length: count },
              (_, index) =>
                `fictional-terminal-m${String(index + 1).padStart(2, "0")}`,
            ),
          ),
        );
        await expect
          .poll(async () => (await sceneMetrics(page))?.page)
          .toMatchObject({
            capacity: expected.capacity,
            pageCount: expected.pageCount,
          });
        await expect(page.locator(".appShell")).toHaveAttribute(
          "data-pager-layout",
          expected.pagerLayout,
        );
        let metrics = (await sceneMetrics(page))!;
        while (metrics.page.pageIndex > 0) {
          await page.getByRole("button", { name: "Previous" }).click();
          await expect
            .poll(async () => (await sceneMetrics(page))?.page.pageIndex)
            .toBe(metrics.page.pageIndex - 1);
          metrics = (await sceneMetrics(page))!;
        }
        if (count === 60 && viewport.width === 1280) {
          await page.evaluate(() =>
            (document.activeElement as HTMLElement | null)?.blur(),
          );
          for (let index = 0; index <= expected.capacity; index++)
            await page.keyboard.press("ArrowRight");
          const expectedFocusedId = `fictional-terminal-m${String(expected.capacity + 1).padStart(2, "0")}`;
          await expect(
            page.locator(
              `.stationA11yMirror button[data-agent-id="${expectedFocusedId}"]`,
            ),
          ).toBeFocused();
          await expect
            .poll(async () => (await sceneMetrics(page))?.page.visibleIds)
            .toContain(expectedFocusedId);
          await page.getByRole("button", { name: "Previous" }).click();
          await expect
            .poll(async () => (await sceneMetrics(page))?.page.pageIndex)
            .toBe(0);
        }
        const discovered = new Set<string>();
        metrics = (await sceneMetrics(page))!;
        expect(metrics.page.capacity).toBe(expected.capacity);
        expect(metrics.page.pageCount).toBe(expected.pageCount);
        for (
          let pageIndex = 0;
          pageIndex < metrics.page.pageCount;
          pageIndex++
        ) {
          await expect
            .poll(async () => {
              const current = await sceneMetrics(page);
              return (
                current?.page.pageIndex === pageIndex &&
                Object.values(current.stationCells).every(
                  (cell) =>
                    cell.x >= 0 &&
                    cell.y >= 0 &&
                    cell.x + cell.width <= viewport.width + 0.001 &&
                    cell.y + cell.height <= viewport.height + 0.001,
                )
              );
            })
            .toBe(true);
          metrics = (await sceneMetrics(page))!;
          const pager =
            metrics.page.pageCount > 1
              ? await page
                  .getByRole("navigation", { name: "Kitchen pages" })
                  .boundingBox()
              : null;
          if (pager)
            expect(
              await page
                .getByRole("navigation", { name: "Kitchen pages" })
                .evaluate(
                  (element) => element.scrollWidth <= element.clientWidth,
                ),
            ).toBe(true);
          if (pager)
            for (const button of await page
              .getByRole("navigation", { name: "Kitchen pages" })
              .getByRole("button")
              .all()) {
              const box = await button.boundingBox();
              expect(box?.width).toBeGreaterThanOrEqual(44);
              expect(box?.height).toBeGreaterThanOrEqual(44);
            }
          if (pager && pageIndex === 0) {
            const hint = await page.locator(".firstHint").boundingBox();
            expect(hint).not.toBeNull();
            expect(boxesIntersect(hint!, pager)).toBe(false);
          }
          expect(metrics.page.pageIndex).toBe(pageIndex);
          expect(
            await buttons.evaluateAll((controls) =>
              controls.map((control) => control.dataset.agentId),
            ),
          ).toEqual(
            Array.from(
              { length: count },
              (_, index) =>
                `fictional-terminal-m${String(index + 1).padStart(2, "0")}`,
            ),
          );
          expect(metrics.page.visibleIds).toEqual(
            Object.keys(metrics.stationCells),
          );
          if (metrics.page.pageCount > 1)
            await expect(
              page.getByText(
                `${metrics.page.visibleIds.length} of ${count} cooks shown · ${count} blocked / ${count - metrics.page.visibleIds.length} off-page`,
              ),
            ).toBeVisible();
          if (count === 16 && viewport.width === 320 && pageIndex === 0) {
            await page.getByRole("button", { name: "Open settings" }).click();
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: "Freezer" }).click();
            await expect
              .poll(async () => (await sceneMetrics(page))?.view)
              .toBe("freezer");
            await page.getByRole("button", { name: "Freezer" }).click();
            await expect
              .poll(async () => (await sceneMetrics(page))?.view)
              .toBe("kitchen");
          }
          const cells = Object.entries(metrics.stationCells);
          for (const [id, cell] of cells) {
            discovered.add(id);
            expect(cell.x).toBeGreaterThanOrEqual(0);
            expect(cell.y).toBeGreaterThanOrEqual(0);
            expect(cell.x + cell.width).toBeLessThanOrEqual(
              viewport.width + 0.001,
            );
            expect(cell.y + cell.height).toBeLessThanOrEqual(
              viewport.height + 0.001,
            );
            if (pager)
              expect(cell.y + cell.height).toBeLessThanOrEqual(pager.y);
            expectInside(metrics.stationNameBounds[id]!, cell);
            expectInside(metrics.stationStatusBounds[id]!, cell);
            expect(
              boxesIntersect(
                metrics.stationNameBounds[id]!,
                metrics.stationStatusBounds[id]!,
              ),
            ).toBe(false);
          }
          cells.forEach(([, cell], index) => {
            for (const [otherId, other] of cells.slice(index + 1))
              expect(
                boxesIntersect(
                  {
                    ...cell,
                    width: cell.width - 0.001,
                    height: cell.height - 0.001,
                  },
                  other,
                ),
                `${count}@${viewport.width}x${viewport.height} ${cells[index]![0]} ${JSON.stringify(cell)} overlaps ${otherId} ${JSON.stringify(other)}`,
              ).toBe(false);
          });
          const placements = Object.values(metrics.blockedPlacements).sort(
            (left, right) => left.queueOrdinal - right.queueOrdinal,
          );
          expect(placements).toHaveLength(metrics.page.visibleIds.length);
          expect(
            placements.every(({ queueTotal }) => queueTotal === count),
          ).toBe(true);
          for (const placement of placements) {
            expect(placement.queueOrdinal).toBe(Number(placement.id.slice(-2)));
            expect(placement.timerText).toMatch(/^\d+:\d{2}$/);
            expect(metrics.stationStatusBounds[placement.id]?.text).toBe(
              `${placement.kind === "pass" ? "AT THE PASS" : "BLOCKED AT STATION"} · ${placement.queueOrdinal}/${count}`,
            );
          }
          if (pageIndex < metrics.page.pageCount - 1) {
            await page
              .getByRole("button", { name: "Next", exact: true })
              .click();
            await expect
              .poll(async () => (await sceneMetrics(page))?.page.pageIndex)
              .toBe(pageIndex + 1);
          }
        }
        expect([...discovered].sort()).toEqual(
          Array.from(
            { length: count },
            (_, index) =>
              `fictional-terminal-m${String(index + 1).padStart(2, "0")}`,
          ),
        );
        if (count === 16 && viewport.width === 1280) {
          expect(metrics.materials).toMatchObject({
            wallPlanes: 3,
            fixtureShadows: 4,
            passEdges: 3,
            stationGroundings: metrics.page.visibleIds.length,
          });
          await page.getByRole("button", { name: "Open settings" }).click();
          await page.getByRole("switch", { name: "Atmosphere" }).click();
          await expect
            .poll(async () => (await sceneMetrics(page))?.atmosphere.pass)
            .toBeGreaterThan(0);
          expect((await sceneMetrics(page))?.materials).toEqual(
            metrics.materials,
          );
          await page.keyboard.press("Escape");
        }
        if (metrics.page.pageCount === 1) {
          const placements = Object.values(metrics.blockedPlacements).sort(
            (left, right) => left.queueOrdinal - right.queueOrdinal,
          );
          expect(placements.map(({ queueOrdinal }) => queueOrdinal)).toEqual(
            Array.from({ length: count }, (_, index) => index + 1),
          );
          expect(
            placements.every(({ queueTotal }) => queueTotal === count),
          ).toBe(true);
          expect(placements.map(({ kind }) => kind).join(",")).toMatch(
            /^pass(?:,pass)*(?:,station)*$/,
          );
          for (const [index, placement] of placements.entries()) {
            expect(placement.timerText).toMatch(/^\d+:\d{2}$/);
            expect(metrics.stationNameBounds[placement.id]?.text).toContain(
              String(index + 1).padStart(2, "0"),
            );
            expect(metrics.stationStatusBounds[placement.id]?.text).toBe(
              `${placement.kind === "pass" ? "AT THE PASS" : "BLOCKED AT STATION"} · ${index + 1}/${count}`,
            );
            const control = buttons.nth(index);
            await expect(control).toContainText(
              `m${String(index + 1).padStart(2, "0")}`,
            );
            await expect(control).toContainText(
              placement.kind === "pass"
                ? "Blocked — at the pass"
                : "Blocked — waiting at station",
            );
            await expect(control).toContainText(
              `queue ${index + 1} of ${count}`,
            );
            await expect(control).toContainText(/\d+(?:h|m|s)/);
            if (placement.kind === "station")
              for (const bound of [
                placement.cookBounds,
                placement.ticket,
                placement.timer,
              ])
                expectInside(bound, metrics.stationCells[placement.id]!);
          }
          const passBounds = placements
            .filter(({ kind }) => kind === "pass")
            .flatMap((placement) => [
              placement.cookBounds,
              placement.ticket,
              placement.timer,
            ]);
          passBounds.forEach((bound, index) => {
            expect(boxesIntersect(bound, placements[0]!.bell)).toBe(false);
            for (const other of passBounds.slice(index + 1))
              expect(boxesIntersect(bound, other)).toBe(false);
          });

          await page.getByRole("button", { name: "Freezer" }).click();
          await page.getByRole("button", { name: "Freezer" }).click();
          await expect
            .poll(async () => (await sceneMetrics(page))?.view)
            .toBe("kitchen");
        }
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.blur(),
        );
        const visibleCount = (await sceneMetrics(page))!.page.visibleIds.length,
          focused = await cycleSceneFocus(page, visibleCount);
        expect(focused.stationIds.size).toBe(visibleCount);
        const active = page.locator(".stationA11yMirror button:focus");
        await expect(active).toHaveCount(1);
        const activeId = await active.getAttribute("data-agent-id");
        expect(activeId).not.toBeNull();
        await page.keyboard.press("Enter");
        await expect(
          page.getByRole("complementary", { name: /details$/ }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (document.activeElement as HTMLElement | null)?.dataset.agentId,
            ),
          )
          .toBe(activeId);
        if (count === 60 && viewport.width === 1280) {
          const found = new Set<string>();
          for (let index = 0; index < count; index++) {
            await page
              .getByRole("button", { name: "Next blocked cook" })
              .click();
            await expect
              .poll(async () => {
                const current = (await sceneMetrics(page))!,
                  [id] = Object.keys(current.activeFocusBounds);
                return id && current.page.visibleIds.includes(id) ? id : null;
              })
              .not.toBeNull();
            found.add(
              Object.keys((await sceneMetrics(page))!.activeFocusBounds)[0]!,
            );
          }
          expect(found.size).toBe(count);
        }
      }
    }

    await page.setViewportSize({ width: 320, height: 640 });
    snapshot = makeSnapshot(12);
    await expect
      .poll(async () => (await sceneMetrics(page))?.page.totalCount)
      .toBe(12);
    let transitionPage = (await sceneMetrics(page))!.page.pageIndex;
    while (transitionPage > 0) {
      await page.getByRole("button", { name: "Previous" }).click();
      await expect
        .poll(async () => (await sceneMetrics(page))?.page.pageIndex)
        .toBe(transitionPage - 1);
      transitionPage = (await sceneMetrics(page))!.page.pageIndex;
    }
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.blockedPlacements[
            "fictional-terminal-01"
          ],
      )
      .not.toBeUndefined();
    snapshot = structuredClone(snapshot);
    snapshot.agents[0]!.agent_status = "working";
    await expect(
      page.getByRole("button", { name: /density-01, Working/ }),
    ).toBeAttached();
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.blockedPlacements["fictional-terminal-01"]
            ?.exiting,
      )
      .toBe(true);
    const duringExit = Object.values(
      (await sceneMetrics(page))!.blockedPlacements,
    );
    duringExit.forEach((placement, index) => {
      for (const other of duringExit.slice(index + 1))
        for (const bound of [
          placement.cookBounds,
          placement.ticket,
          placement.timer,
        ])
          for (const otherBound of [
            other.cookBounds,
            other.ticket,
            other.timer,
          ])
            expect(
              boxesIntersect(bound, otherBound),
              `${placement.id} ${JSON.stringify(bound)} intersects ${other.id} ${JSON.stringify(otherBound)}`,
            ).toBe(false);
    });
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.blockedPlacements[
            "fictional-terminal-01"
          ],
      )
      .toBeUndefined();

    snapshot = structuredClone(snapshot);
    snapshot.agents[1]!.agent_status = "done";
    await expect(
      page.getByRole("button", { name: /density-02, Done/ }),
    ).toBeAttached({ timeout: 10_000 });
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.blockedPlacements["fictional-terminal-02"]
            ?.exiting,
      )
      .toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(async () => ({
        retained: (await sceneMetrics(page))?.blockedPlacements[
          "fictional-terminal-02"
        ],
        transitions: (await sceneMetrics(page))?.motion.activeTransitions,
      }))
      .toEqual({ retained: undefined, transitions: 0 });

    snapshot = structuredClone(snapshot);
    snapshot.agents[2]!.agent_status = "working";
    await expect(
      page.getByRole("button", { name: /density-03, Working/ }),
    ).toBeAttached({ timeout: 10_000 });
    await expect
      .poll(async () => ({
        retained: (await sceneMetrics(page))?.blockedPlacements[
          "fictional-terminal-03"
        ],
        transitions: (await sceneMetrics(page))?.motion.activeTransitions,
      }))
      .toEqual({ retained: undefined, transitions: 0 });

    snapshot = makeSnapshot(12);
    await expect
      .poll(
        async () =>
          (await sceneMetrics(page))?.blockedPlacements[
            "fictional-terminal-01"
          ],
      )
      .not.toBeUndefined();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    snapshot = structuredClone(snapshot);
    snapshot.agents[0]!.agent_status = "working";
    await expect(
      page.getByRole("button", { name: /density-01, Working/ }),
    ).toBeAttached();
    await expect(
      page.getByText("6 of 12 cooks shown · 11 blocked / 6 off-page"),
    ).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    snapshot = makeSnapshot(30);
    const selectedId = "fictional-terminal-20",
      liveButtons = page
        .getByRole("navigation", { name: "Agent stations" })
        .getByRole("button", { name: /Blocked —/ });
    await expect(liveButtons).toHaveCount(30);
    await liveButtons.nth(19).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("complementary", { name: /density-20 details/i }),
    ).toBeVisible();
    const reversed = makeSnapshot(30);
    reversed.agents.reverse();
    reversed.agents.find(
      (agent) => agent.terminal_id === selectedId,
    )!.agent_status = "working";
    for (const next of [
      reversed,
      makeSnapshot(60),
      {
        ...makeSnapshot(5),
        agents: makeSnapshot(30).agents.slice(17, 22),
      },
    ]) {
      snapshot = next;
      await expect
        .poll(async () => {
          const current = (await sceneMetrics(page))!;
          return current.page.visibleIds.includes(selectedId);
        })
        .toBe(true);
      await expect(
        page.getByRole("complementary", { name: /density-20 details/i }),
      ).toBeVisible();
      if (next === reversed) {
        const current = (await sceneMetrics(page))!;
        await expect(
          page.getByText(
            `${current.page.visibleIds.length} of 30 cooks shown · 29 blocked / ${30 - current.page.visibleIds.length} off-page`,
          ),
        ).toBeVisible();
      }
    }
  } finally {
    app.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("atmosphere persists across the production fixture runtime", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-atmosphere-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    fixture = await readFile(
      join(process.cwd(), "protocol/fixtures/snapshot.v1.json"),
      "utf8",
    ),
    app = spawn("target/debug/herdr-mise", [], {
      env: {
        ...process.env,
        HERDR_MISE_PORT: String(port),
        HERDR_SOCKET_PATH: join(directory, "herdr.sock"),
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
    await page.routeWebSocket("**/ws?paneId=1", (webSocket) => {
      webSocket.send(fixture);
    });
    await page.goto(`${appUrl}/?stats`);
    await expect(
      page.getByRole("button", {
        name: "refactor-agent, Working — on the fire, open details",
      }),
    ).toBeAttached();
    await expect(
      page.getByRole("button", {
        name: "review-agent, Idle — prepping, open details",
      }),
    ).toBeAttached();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        atmosphere: { shelf: 2 },
        board: { headers: ["COOK", "MISE TIME"] },
      });

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("switch", { name: "Atmosphere" }).click();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({ atmosphere: { window: 0, shelf: 0, pass: 0 } });

    await page.reload();
    await expect(
      page.getByRole("button", {
        name: "refactor-agent, Working — on the fire, open details",
      }),
    ).toBeAttached();
    await expect
      .poll(async () => sceneMetrics(page))
      .toMatchObject({
        atmosphere: { window: 0, shelf: 0, pass: 0 },
        board: { headers: ["COOK", "MISE TIME"] },
      });
    await page.getByRole("button", { name: "Open settings" }).click();
    await expect(
      page.getByRole("switch", { name: "Atmosphere" }),
    ).toHaveAttribute("aria-checked", "false");
  } finally {
    app.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejected state update resynchronizes through a fresh snapshot", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-mise-rejection-")),
    port = await availablePort(),
    appUrl = `http://127.0.0.1:${port}`,
    snapshot = await readFile(
      join(process.cwd(), "protocol/fixtures/snapshot.v1.json"),
      "utf8",
    ),
    delta = JSON.parse(
      await readFile(
        join(process.cwd(), "protocol/fixtures/delta-upsert.v1.json"),
        "utf8",
      ),
    ) as { agent: { name: string } },
    heartbeat = await readFile(
      join(process.cwd(), "protocol/fixtures/heartbeat.v1.json"),
      "utf8",
    ),
    rejected = JSON.stringify({
      ...delta,
      agent: { ...delta.agent, name: "x".repeat(4097) },
    }),
    app = spawn("target/debug/herdr-mise", [], {
      env: {
        ...process.env,
        HERDR_MISE_PORT: String(port),
        HERDR_SOCKET_PATH: join(directory, "herdr.sock"),
      },
      stdio: "ignore",
    });
  let connections = 0;
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
    await page.routeWebSocket("**/ws?paneId=1", (webSocket) => {
      connections++;
      if (connections === 1) {
        webSocket.send(snapshot);
        webSocket.send(rejected);
        webSocket.send(heartbeat);
      } else if (connections === 2) webSocket.send(rejected);
      else webSocket.send(snapshot);
    });
    await page.goto(appUrl);

    await expect(page.getByRole("alert")).toContainText(
      "Browser received an incompatible Mise feed",
      { timeout: 10_000 },
    );
    await expect(
      page.getByRole("button", { name: /refactor-agent, Blocked/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "refactor-agent, Working — on the fire, open details",
      }),
    ).toBeAttached({ timeout: 10_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(connections).toBeGreaterThanOrEqual(3);
  } finally {
    app.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
});
