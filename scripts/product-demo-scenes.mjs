// Shared browser actions for the 75-second product demo capture and the
// product-demo browser tests. The capture owns editorial timing and frame
// pacing; these actions only put the deterministic visual playground into a
// known, captioned state.
//
// Clock contract: the caller installs and pauses the Playwright clock before
// navigation. `prepareProductScene` advances it to a deterministic checkpoint
// (3s for the attention blocked state, a short settle otherwise). The capture
// must never advance past `productClockCeiling(scene)` while a blocked frame
// must stay blocked, or the 3s blocked / 8s resume timers race the editorial
// timeline.

export const PRODUCT_SCENES = Object.freeze([
  "busy",
  "blocked",
  "details",
  "workspace",
  "comparison",
  "recap",
  "installation",
]);

export const PRODUCT_MAIN_DURATION_SECONDS = 75;

// attention-story.json blocks Codex at 3s and resumes at 8s.
export const PRODUCT_ATTENTION_BLOCKED_MS = 3_000;
export const PRODUCT_ATTENTION_RESUME_MS = 8_000;
// Stop short of the resume timer so a long blocked segment can hold the frame.
export const PRODUCT_ATTENTION_HOLD_MS = PRODUCT_ATTENTION_RESUME_MS - 100;
// Enough clock to drive one render frame without changing demo state.
export const PRODUCT_SETTLE_MS = 250;

export const PRODUCT_SCENE_QUERY = Object.freeze({
  busy: "preset=working&agents=6&theme=light",
  blocked: "preset=attention&agents=6&theme=light",
  details: "preset=attention&agents=6&theme=light",
  workspace: "preset=mixed&agents=6&theme=light",
  comparison: "preset=working&agents=6&theme=light",
  recap: "preset=mixed&agents=6&theme=light",
  installation: "preset=working&agents=6&theme=light",
});

// README quick start, shown verbatim in the installation segment and listed
// in transcripts. Never executed by capture.
export const PRODUCT_INSTALL_COMMANDS = Object.freeze([
  "brew install herdr",
  "herdr plugin install funsaized/herdr-mise",
  "herdr plugin action invoke open --plugin mise.kitchen",
]);

export const PRODUCT_CAPTION_ID = "capture-caption";
export const PRODUCT_INSTALL_CARD_ID = "product-install-card";

const INSTALL_STYLE_ID = "product-install-card-style";
const INSTALL_STYLE = `#${PRODUCT_INSTALL_CARD_ID}{position:fixed;left:24px;bottom:24px;z-index:30;max-width:min(560px,calc(100vw - 48px));padding:12px 16px;color:var(--text);background:var(--panel);border:3px solid var(--panel);border-radius:var(--radiusControl);box-shadow:var(--shadow);font:600 14px/1.4 var(--fontChrome)}#${PRODUCT_INSTALL_CARD_ID} h2{margin:0 0 6px;font-size:16px}#${PRODUCT_INSTALL_CARD_ID} pre{margin:0;overflow:auto;white-space:pre-wrap;font:600 13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}#${PRODUCT_INSTALL_CARD_ID} p{margin:6px 0 0;color:var(--secondary)}`;

export function productSceneClockCeiling(scene) {
  return scene === "blocked" || scene === "details"
    ? PRODUCT_ATTENTION_HOLD_MS
    : 60_000;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function requireVisible(locator, label, description) {
  try {
    await locator.first().waitFor({ state: "visible" });
  } catch {
    throw new Error(`${label}: expected ${description} to be visible`);
  }
}

async function openProductScene(page, baseUrl, scene, label) {
  const query = PRODUCT_SCENE_QUERY[scene];
  if (!query) throw new Error(`${label}: unknown product scene ${scene}`);
  await page.goto(`${baseUrl}/?${query}`, { waitUntil: "networkidle" });
  // The React chrome and DEMO placard resolve from the mock socket microtask,
  // which runs while the Playwright clock is paused. The canvas renderer needs
  // a clock tick, so it is awaited only after the scene's runFor below.
  await page.locator("main.appShell").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  const dismiss = page.getByRole("button", { name: "Got it" });
  if ((await dismiss.count()) && (await dismiss.first().isVisible()))
    await dismiss.first().click();
  await requireVisible(
    page.getByRole("status").filter({ hasText: "DEMO SERVICE" }),
    label,
    "DEMO SERVICE placard",
  );
  return query;
}

/**
 * Render or update the product-demo caption overlay.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} text caption body (the capture may include version/source)
 * @param {string} label stable scene id for diagnostics and `data-product-scene`
 */
export async function setProductCaption(page, text, label) {
  if (typeof text !== "string" || text.length === 0)
    throw new Error(`${label}: product caption text is required`);
  await page.evaluate(
    ({ id, text, label }) => {
      const shell = document.querySelector(".appShell");
      if (!shell)
        throw new Error(`${label}: product demo app shell is missing`);
      let caption = document.getElementById(id);
      if (!caption) {
        caption = document.createElement("div");
        caption.id = id;
        caption.className = "captureCaption";
        shell.append(caption);
      }
      caption.textContent = text;
      caption.dataset.productScene = label;
      caption.setAttribute("aria-label", `Demo caption: ${label}`);
    },
    { id: PRODUCT_CAPTION_ID, text, label },
  );
}

/**
 * Prepare one deterministic product-demo scene. The caller must have installed
 * and paused the Playwright clock before this navigates.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} baseUrl visual playground origin
 * @param {string} scene one of `PRODUCT_SCENES`
 * @param {string} label stable scene id for diagnostics
 * @returns {Promise<{ scene: string, query: string }>}
 */
export async function prepareProductScene(page, baseUrl, scene, label) {
  const query = await openProductScene(page, baseUrl, scene, label);
  switch (scene) {
    case "busy":
      await page.clock.runFor(PRODUCT_SETTLE_MS);
      break;
    case "blocked":
      await page.clock.runFor(PRODUCT_ATTENTION_BLOCKED_MS);
      await requireVisible(
        page.getByRole("button", { name: /^Codex, Blocked/ }),
        label,
        "blocked Codex station",
      );
      break;
    case "details":
      await page.clock.runFor(PRODUCT_ATTENTION_BLOCKED_MS);
      await inspectProductStation(
        page,
        { name: "Codex", paneId: "visual-pane-1" },
        label,
      );
      break;
    case "workspace":
      await page.clock.runFor(PRODUCT_SETTLE_MS);
      await selectProductWorkspace(page, "visual-workspace-1", label);
      await requireVisible(
        page.getByRole("button", { name: /blocked elsewhere — Show all/ }),
        label,
        "blocked-elsewhere recovery",
      );
      break;
    case "comparison":
      await page.clock.runFor(PRODUCT_SETTLE_MS);
      await page.getByRole("button", { name: "Expand recording" }).click();
      await requireVisible(
        page.locator('figure.visualTuiFigure[data-expanded="true"]'),
        label,
        "prerecorded TUI figure",
      );
      break;
    case "recap":
      await page.clock.runFor(PRODUCT_SETTLE_MS);
      await page.locator("details.serviceRecap > summary").click();
      await requireVisible(
        page.locator("details.serviceRecap[open]"),
        label,
        "service recap",
      );
      break;
    case "installation":
      await page.clock.runFor(PRODUCT_SETTLE_MS);
      await renderProductInstallCard(page, label);
      break;
    default:
      throw new Error(`${label}: unknown product scene ${scene}`);
  }
  // The scene's runFor has driven at least one clock tick for the renderer.
  await page.locator("canvas").waitFor({ state: "visible" });
  return { scene, query };
}

/**
 * Click a station through its semantic (visually hidden) button and verify the
 * real detail card shows the exact pane locator.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{ name: string, paneId: string }} target
 * @param {string} label
 */
export async function inspectProductStation(page, { name, paneId }, label) {
  const station = page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(name)},`),
  });
  await requireVisible(station, label, `${name} station`);
  await station.first().evaluate((element) => element.click());
  const details = page.getByRole("complementary", { name: `${name} details` });
  await requireVisible(details, label, `${name} details`);
  await requireVisible(
    details.getByLabel(`Pane locator value: ${paneId}`),
    label,
    `pane locator ${paneId}`,
  );
  return details;
}

/**
 * Select a workspace by its stable id, even when labels collide.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} workspaceId
 * @param {string} label
 */
export async function selectProductWorkspace(page, workspaceId, label) {
  const selector = page.getByRole("combobox", { name: "Workspace" });
  await requireVisible(selector, label, "Workspace control");
  await selector.selectOption(workspaceId);
  const value = await selector.inputValue();
  if (value !== workspaceId)
    throw new Error(
      `${label}: workspace ${workspaceId} did not stay selected (got ${value})`,
    );
  return selector;
}

async function renderProductInstallCard(page, label) {
  await page.evaluate(
    ({ cardId, styleId, style, commands, label }) => {
      const shell = document.querySelector(".appShell");
      if (!shell)
        throw new Error(`${label}: product demo app shell is missing`);
      if (!document.getElementById(styleId)) {
        const element = document.createElement("style");
        element.id = styleId;
        element.textContent = style;
        document.head.append(element);
      }
      let card = document.getElementById(cardId);
      if (!card) {
        card = document.createElement("section");
        card.id = cardId;
        card.className = "productInstallCard";
        shell.append(card);
      }
      card.setAttribute("aria-label", "Installation");
      card.dataset.productScene = label;
      const heading = document.createElement("h2");
      heading.textContent = "Install herdr-mise";
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = commands.join("\n");
      pre.append(code);
      const note = document.createElement("p");
      note.textContent =
        "Shown from the README quick start; this capture never executes them.";
      card.replaceChildren(heading, pre, note);
    },
    {
      cardId: PRODUCT_INSTALL_CARD_ID,
      styleId: INSTALL_STYLE_ID,
      style: INSTALL_STYLE,
      commands: PRODUCT_INSTALL_COMMANDS,
      label,
    },
  );
}
