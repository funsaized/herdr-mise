import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRODUCT_MAIN_DURATION_SECONDS,
  PRODUCT_SCENES,
  inspectProductStation,
  prepareProductScene,
  selectProductWorkspace,
  setProductCaption,
} from "../scripts/product-demo-scenes.mjs";
import { startFixtureApp } from "./fixture-app";
import { watchErrors } from "./visual-helpers";
import { visualOrigin } from "./visual-origin";
import {
  readSourceVersion,
  storyboard,
  versionLabel,
} from "../scripts/product-demo-config.mjs";

async function assertProductCheckpoint(
  page: Page,
  scene: string,
  caption: string,
) {
  switch (scene) {
    case "busy":
      await expect(
        page.getByRole("status").filter({ hasText: "DEMO SERVICE" }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("navigation", { name: "Agent stations" })
          .getByRole("button"),
      ).toHaveCount(6);
      break;
    case "blocked":
      await expect(
        page.getByRole("button", { name: /^Codex, Blocked/ }),
      ).toBeVisible();
      break;
    case "details": {
      const details = page.getByRole("complementary", {
        name: "Codex details",
      });
      await expect(details).toBeVisible();
      await expect(
        details.getByLabel("Pane locator value: visual-pane-1"),
      ).toBeVisible();
      await expect(details).toContainText("checkout-api");
      break;
    }
    case "workspace":
      await expect(
        page.getByRole("combobox", { name: "Workspace" }),
      ).toHaveValue("visual-workspace-1");
      await expect(
        page.getByRole("button", { name: /blocked elsewhere — Show all/ }),
      ).toBeVisible();
      break;
    case "comparison": {
      const figure = page.locator(
        'figure.visualTuiFigure[data-expanded="true"]',
      );
      await expect(figure).toBeVisible();
      const video = figure.locator("video");
      await expect(video).toHaveAttribute("poster", "/tui-demo-poster.png");
      await expect(video.locator("source")).toHaveCount(2);
      await expect(video.locator("source").first()).toHaveAttribute(
        "src",
        "/tui-demo.mp4",
      );
      await expect(video.locator("source").last()).toHaveAttribute(
        "src",
        "/tui-demo.webm",
      );
      await expect(figure.locator("figcaption")).toContainText(
        "Headless recording of herdr-mise --tui",
      );
      break;
    }
    case "recap": {
      const recap = page.locator("details.serviceRecap");
      await expect(recap).toHaveAttribute("open");
      await expect(recap).toContainText("Observed time blocked:");
      break;
    }
    case "installation": {
      const card = page.locator("#product-install-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("brew install herdr");
      await expect(card).toContainText(
        "herdr plugin install funsaized/herdr-mise",
      );
      await expect(card).toContainText(
        "herdr plugin action invoke open --plugin mise.kitchen",
      );
      await expect(page.locator(".captureCaption")).toContainText("herdr-mise");
      await expect(page.locator(".captureCaption")).toContainText("source");
      break;
    }
    default:
      throw new Error(`unexpected product checkpoint ${scene}`);
  }
  await expect(page.locator(".captureCaption")).toContainText(caption);
}

test("product capture actions inspect fixture locators and scope workspaces by stable ID", async ({
  page,
}) => {
  test.setTimeout(120_000);
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
      prefix: "herdr-mise-product-scope-",
      snapshot: initial,
    });
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${fixture.appUrl}/?stats`);

    const selector = page.getByRole("combobox", { name: "Workspace" });
    await expect(selector).toHaveValue("");
    const options = await selector.locator("option").evaluateAll((items) =>
      items.map((item) => ({
        value: (item as HTMLOptionElement).value,
        label: item.textContent ?? "",
      })),
    );
    // Duplicate labels stay distinct because the control keys off stable IDs.
    expect(options).toEqual(
      expect.arrayContaining([
        { value: "", label: "All" },
        { value: "scope-workspace-one", label: "duplicate (aceone)" },
        { value: "scope-workspace-two", label: "duplicate (acetwo)" },
        { value: "scope-workspace-empty", label: "empty" },
      ]),
    );

    // The real Rust fixture boundary surfaces the exact pane locator.
    await inspectProductStation(
      page,
      { name: "scope-blocked", paneId: "scope-pane-two" },
      "product-fixture",
    );
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("complementary", { name: "scope-blocked details" }),
    ).toHaveCount(0);

    // Selecting by stable ID despite duplicated labels keeps blocked attention
    // recoverable, not hidden.
    await selectProductWorkspace(
      page,
      "scope-workspace-one",
      "product-fixture",
    );
    await expect(
      page.getByRole("button", { name: /scope-blocked, Blocked/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "1 blocked elsewhere — Show all" }),
    ).toBeVisible();

    // An empty workspace is explicit, not silently blank.
    await selectProductWorkspace(
      page,
      "scope-workspace-empty",
      "product-fixture",
    );
    await expect(
      page.getByRole("status").filter({ hasText: "No agents in empty" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /scope-working, Working/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /scope-blocked, Blocked/ }),
    ).toHaveCount(0);

    // The blocked workspace is still selectable by ID after the empty scope.
    await selectProductWorkspace(
      page,
      "scope-workspace-two",
      "product-fixture",
    );
    await expect(
      page.getByRole("button", { name: /scope-blocked, Blocked/ }),
    ).toBeAttached();
  } finally {
    await fixture.close();
  }
});

test("product storyboard renders captioned demo checkpoints without publishing media", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const PRODUCT_STORYBOARD = storyboard.map((cue) => ({
    ...cue,
    caption:
      cue.scene === "installation"
        ? versionLabel(readSourceVersion(process.cwd()), "0123abc")
        : cue.caption,
  }));
  expect(PRODUCT_STORYBOARD.map(({ scene }) => scene)).toEqual([
    ...PRODUCT_SCENES,
  ]);
  expect(PRODUCT_STORYBOARD.at(-1)!.end).toBe(PRODUCT_MAIN_DURATION_SECONDS);
  for (const [index, cue] of PRODUCT_STORYBOARD.entries()) {
    if (index) expect(cue.start).toBe(PRODUCT_STORYBOARD[index - 1]!.end);
    expect(cue.end).toBeGreaterThan(cue.start);
  }

  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  // Install and pause before navigation so the 3s blocked / 8s resume timers
  // only move when a scene asks them to.
  const clockTime = Date.parse("2026-01-01T00:00:00.000Z");
  await page.clock.install({ time: clockTime });
  await page.clock.pauseAt(clockTime);

  for (const checkpoint of PRODUCT_STORYBOARD) {
    const label = `product-${checkpoint.scene}`;
    await prepareProductScene(page, visualOrigin, checkpoint.scene, label);
    await setProductCaption(page, checkpoint.caption, label);
    const caption = page.locator(".captureCaption");
    await expect(caption).toHaveText(checkpoint.caption);
    await expect(caption).toHaveAttribute("data-product-scene", label);
    await assertProductCheckpoint(page, checkpoint.scene, checkpoint.caption);
    // Temporary artifact under the gitignored Playwright output dir.
    await page.screenshot({
      path: testInfo.outputPath(`${checkpoint.scene}.png`),
    });
  }
  expect(errors).toEqual([]);
});
