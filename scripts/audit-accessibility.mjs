import { readFileSync } from "node:fs";
const source = readFileSync(
    new URL("../client/src/theme/tokens.ts", import.meta.url),
    "utf8",
  ),
  scene = readFileSync(
    new URL("../client/src/scene/kitchen-scene.ts", import.meta.url),
    "utf8",
  ),
  app = readFileSync(new URL("../client/src/App.tsx", import.meta.url), "utf8"),
  globalCss = readFileSync(
    new URL("../client/src/theme/global.css", import.meta.url),
    "utf8",
  );
function token(name) {
  const match = source.match(new RegExp(`${name}:\\s*"(#[0-9a-fA-F]{6})"`));
  if (!match) throw new Error(`Missing token ${name}`);
  return match[1];
}
function luminance(hex) {
  const values = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}
function contrast(a, b) {
  const one = luminance(a),
    two = luminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}
function luminanceRgb(rgb) {
  const values = rgb
    .slice(0, 3)
    .map((channel) => channel / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}
// Contrast between already-resolved RGB triples, so alpha-composited and
// CSS-filtered colours can be checked without round-tripping through hex.
function contrastRgb(front, back) {
  const one = luminanceRgb(front),
    two = luminanceRgb(back);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}
function rawValue(name) {
  const match = source.match(new RegExp(`${name}:\\s*"([^"]+)"`));
  return match?.[1] ?? null;
}
function parseColor(value) {
  if (!value) return null;
  const trimmed = value.trim(),
    hex = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (hex)
    return [0, 2, 4]
      .map((index) => parseInt(hex[1].slice(index, index + 2), 16))
      .concat(1);
  const rgba =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
      trimmed,
    );
  return rgba
    ? [+rgba[1], +rgba[2], +rgba[3], rgba[4] === undefined ? 1 : +rgba[4]]
    : null;
}
// Straight alpha compositing in the sRGB channel space, matching what the
// browser paints for a solid translucent surface over a scene colour.
function composite(front, back) {
  const alpha = front[3];
  return [0, 1, 2].map(
    (index) => front[index] * alpha + back[index] * (1 - alpha),
  );
}
function clampChannel(value) {
  return Math.min(255, Math.max(0, value));
}
// CSS filter functions run on gamma-encoded sRGB channels in declaration
// order, so grayscale() uses the luminance coefficients before brightness().
function applyFilter(color, name, amount) {
  if (name === "brightness")
    return color.map((channel) => clampChannel(channel * amount));
  const gray = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  return color.map((channel) =>
    clampChannel(channel + (gray - channel) * amount),
  );
}
function applyFilters(color, filters) {
  let result = color;
  for (const [name, amount] of filters)
    result = applyFilter(result, name, amount);
  return result;
}
function cssFilters(selector) {
  const declaration = globalCss.match(
    new RegExp(`\\.${selector}\\s*\\{[^}]*filter:\\s*([^;]+);`),
  )?.[1];
  if (!declaration) return null;
  const filters = [
    ...declaration.matchAll(/(grayscale|brightness)\(\s*([\d.]+)\s*\)/g),
  ].map((match) => [match[1], +match[2]]);
  return filters.length ? filters : null;
}
const checks = [
  ["text", "panel", 4.5],
  ["textMuted", "panel", 4.5],
  ["secondary", "panel", 4.5],
  ["tertiary", "panel", 4.5],
  ["buttonText", "text", 4.5],
  ["tooltipSecondary", "ink", 4.5],
];
const failures = [];
for (const [front, back, minimum] of checks) {
  const ratio = contrast(token(front), token(back));
  console.log(`${front}/${back}: ${ratio.toFixed(2)}:1`);
  if (ratio < minimum)
    failures.push(`${front}/${back} ${ratio.toFixed(2)} < ${minimum}`);
}
const tokenSource = readFileSync(
  new URL("../client/src/theme/tokens.ts", import.meta.url),
  "utf8",
);
const floorPair =
  tokenSource
    .match(/floor:\s*\["(#[0-9a-fA-F]{6})",\s*"(#[0-9a-fA-F]{6})"/)
    ?.slice(1) ?? [];
const stationLabelChecks = [
  "stationName",
  "stationState.idle",
  "stationState.working",
  "stationState.blocked",
  "stationState.done",
  "stationState.ended",
];
function resolvePairValue(value) {
  const normalized = value.trim().replaceAll('"', "");
  if (normalized.startsWith("semantic.")) {
    const name = normalized.slice("semantic.".length),
      semanticValue = tokenSource.match(
        new RegExp(`\\b${name}:\\s*\\"(#[0-9a-fA-F]{6})`),
      );
    return semanticValue?.[1] ?? null;
  }
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : null;
}
function tokenPair(path) {
  const match = path.includes(".")
    ? tokenSource.match(
        new RegExp(
          `${path.split(".")[0]}:\\s*\\{[^}]*${path.split(".")[1]}:\\s*\\[([^,]+),\\s*([^\\]]+)\\]`,
        ),
      )
    : tokenSource.match(new RegExp(`${path}:\\s*\\[([^,]+),\\s*([^\\]]+)\\]`));
  return match
    ? [resolvePairValue(match[1]), resolvePairValue(match[2])]
    : [null, null];
}
for (const [themeIndex, theme] of ["day", "dinner"].entries()) {
  const floor = floorPair[themeIndex] ?? "";
  for (const path of stationLabelChecks) {
    const value = tokenPair(path)[themeIndex],
      ratio = value && floor ? contrast(value, floor) : 0;
    console.log(`${theme} ${path}/floor: ${ratio.toFixed(2)}:1`);
    if (!value || !floor || ratio < 4.5)
      failures.push(`${theme} ${path} ${ratio.toFixed(2)} < 4.5`);
  }
}
const wallPair =
    tokenSource
      .match(/wall:\s*\["(#[0-9a-fA-F]{6})",\s*"(#[0-9a-fA-F]{6})"/)
      ?.slice(1) ?? [],
  freezerSource = tokenSource.slice(tokenSource.indexOf("freezer:")),
  freezerFloor =
    freezerSource
      .match(/floor:\s*\["(#[0-9a-fA-F]{6})",\s*"(#[0-9a-fA-F]{6})"/)
      ?.slice(1) ?? [],
  freezerIce =
    freezerSource
      .match(/ice:\s*\["(#[0-9a-fA-F]{6})",\s*"(#[0-9a-fA-F]{6})"/)
      ?.slice(1) ?? [],
  freezerBody = freezerSource.match(/body:\s*"(#[0-9a-fA-F]{6})"/)?.[1] ?? null,
  surface = parseColor(rawValue("surface")),
  surfaceBlur = rawValue("surfaceBlur"),
  surfaceBorder = parseColor(rawValue("borderSoft")),
  panelSoft = parseColor(rawValue("panelSoft")),
  panel = parseColor(token("panel"));
if (!surface) failures.push("chrome.surface missing or not a parseable rgba");
else if (surface[3] <= 0 || surface[3] >= 1)
  failures.push("chrome.surface must stay translucent (0 < alpha < 1)");
if (!surfaceBlur || !/^\d+(\.\d+)?px$/.test(surfaceBlur))
  failures.push("chrome.surfaceBlur missing or not a px value");
if (!surfaceBorder)
  failures.push("chrome.surfaceBorder missing or not a parseable color");
if (!/prefers-reduced-transparency/.test(globalCss))
  failures.push(
    "global.css lacks a prefers-reduced-transparency opaque fallback",
  );
// The scene backdrops persistent chrome can legitimately sit over: kitchen
// wall/floor per theme, the freezer's blue body, and its floor/ice per theme.
const backdrops = [
  ["day wall", wallPair[0]],
  ["day floor", floorPair[0]],
  ["dinner wall", wallPair[1]],
  ["dinner floor", floorPair[1]],
  ["freezer body", freezerBody],
  ["freezer day floor", freezerFloor[0]],
  ["freezer dinner floor", freezerFloor[1]],
  ["freezer day ice", freezerIce[0]],
  ["freezer dinner ice", freezerIce[1]],
].filter(([, value]) => Boolean(value));
const filterStates = [
  ["default", []],
  ["settings dim (brightness .88)", cssFilters("dimmed")],
  ["disconnected (grayscale .85 brightness .8)", cssFilters("disconnected")],
];
if (!filterStates[1][1])
  failures.push("global.css lacks the .canvasHost.dimmed brightness filter");
if (!filterStates[2][1])
  failures.push("global.css lacks the .canvasHost.disconnected filter");
// HUD copy is normal-size text (AA 4.5:1); state cues are bold/large or
// graphical (AA non-text 3:1). Both are resolved from the real token values.
const hudText = ["text", "textWarm", "textMuted", "secondary", "tertiary"],
  cueText = [
    ["workingText", "workingText"],
    ["doneText", "doneText"],
    ["focus ring (chrome.text)", "text"],
  ],
  surfaces = [
    ["opaque panel", panel],
    ["panelSoft .94", panelSoft],
    ["surface .72", surface],
  ],
  worst = new Map();
function record(kind, name, ratio, context, minimum) {
  const key = `${kind}:${name}`,
    current = worst.get(key);
  if (!current || ratio < current.ratio)
    worst.set(key, { name, ratio, context, minimum });
}
for (const [surfaceName, surfaceColor] of surfaces) {
  if (!surfaceColor) continue;
  for (const [backdropName, backdropHex] of backdrops) {
    const backdrop = parseColor(backdropHex);
    if (!backdrop) continue;
    for (const [filterName, filters] of filterStates) {
      if (!filters) continue;
      const background = composite(
        surfaceColor,
        applyFilters(backdrop.slice(0, 3), filters),
      );
      for (const name of hudText) {
        const front = parseColor(rawValue(name));
        if (!front) continue;
        const effective =
            front[3] < 1 ? composite(front, background) : front.slice(0, 3),
          ratio = contrastRgb(effective, background),
          context = `${surfaceName} over ${backdropName}, ${filterName}`;
        record("hud", name, ratio, context, 4.5);
        if (ratio < 4.5)
          failures.push(`HUD ${name} ${ratio.toFixed(2)} < 4.5 (${context})`);
      }
      for (const [label, name] of cueText) {
        const front = parseColor(rawValue(name));
        if (!front) continue;
        const effective =
            front[3] < 1 ? composite(front, background) : front.slice(0, 3),
          ratio = contrastRgb(effective, background),
          context = `${surfaceName} over ${backdropName}, ${filterName}`;
        record("cue", label, ratio, context, 3);
        if (ratio < 3)
          failures.push(`cue ${label} ${ratio.toFixed(2)} < 3 (${context})`);
      }
    }
  }
}
for (const { name, ratio, context, minimum } of worst.values())
  console.log(
    `${name} min ${ratio.toFixed(2)}:1 (need ${minimum}) — ${context}`,
  );
if (!/state\s*===\s*"blocked"[\s\S]*?\.circle\(/.test(scene))
  failures.push("blocked state lacks bell/circle shape");
if (!/state\s*===\s*"done"[\s\S]*?\.ellipse\(/.test(scene))
  failures.push("done state lacks plate/ellipse shape");
const liveRegion =
  app.match(/<div(?=[^>]*className="liveRegion")[^>]*>/)?.[0] ?? "";
if (
  !/aria-label="[^"]+"/.test(liveRegion) ||
  !liveRegion.includes('aria-live="polite"') ||
  !liveRegion.includes('aria-atomic="true"')
)
  failures.push(
    "live region lacks a concise accessible name or polite/atomic semantics",
  );
console.log(
  "CVD evidence: blocked uses bell/circle plus PASS text; done uses plate/ellipse plus PLATED text, independent of simulated hue.",
);
if (failures.length) {
  console.error(`Accessibility audit failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("Accessibility audit passed.");
