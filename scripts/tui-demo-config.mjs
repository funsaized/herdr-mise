// Storyboard and recording profile for the headless TUI demo: a ~30-second,
// captioned tour of the terminal UI recorded by VHS from the release binary in
// demo mode. The tape, captions, WebVTT track, and transcript all derive from
// this one storyboard. Import-safe: no processes, files, or network.

export const TUI_DEMO_SCHEMA = "demo-capture-v2";
export const TUI_DEMO_CAPTURE_PATH = "scripts/tui-demo.capture.json";
export const TUI_DEMO_PROVENANCE =
  "headless VHS recording of the release binary in demo mode";
export const TUI_DEMO_DURATION_SECONDS = 30;
export const TUI_DEMO_TITLE = "herdr-mise --tui";

const asset = (name) => `docs/assets/${name}`;

export const tuiOutputs = Object.freeze({
  gif: { path: asset("herdr-mise-tui-demo.gif"), codec: "gif" },
  mp4: { path: asset("herdr-mise-tui-demo.mp4"), codec: "h264" },
  webm: { path: asset("herdr-mise-tui-demo.webm"), codec: "vp9" },
  poster: { path: asset("herdr-mise-tui-demo-poster.png"), codec: "png" },
  vtt: { path: asset("herdr-mise-tui-demo.vtt"), codec: null },
  txt: { path: asset("herdr-mise-tui-demo.txt"), codec: null },
});

// The README GIF and its poster share the historical 1.5 MiB budget; the MP4
// and WebM keep the full frame rate and size.
export const TUI_MEDIA_BUDGET_BYTES = 1_572_864;
export const TUI_FRAME_RATE = 20;
export const TUI_GIF_FRAME_RATE = 10;
export const TUI_GIF_WIDTH = 800;
export const TUI_DURATION_TOLERANCE_SECONDS = 0.25;
// VHS screenshots the virtual terminal on a best-effort timer and drops frames
// under load. Fewer than this share of the expected frames fails the capture.
export const TUI_MIN_FRAME_RATIO = 0.85;
// Seconds into the tour used for the poster (Claude blocked and selected).
export const TUI_POSTER_SECONDS = 6;

// Menlo ships with macOS. VHS silently substitutes a wide fallback face for a
// missing font, so the capture verifies the font and the resulting grid.
export const tuiTerminal = Object.freeze({
  fontFamily: "Menlo",
  fontSize: 14,
  lineHeight: 1,
  letterSpacing: 0,
  width: 1080,
  height: 780,
  padding: 20,
  background: "#121212",
  // Below this grid the TUI falls back to its compact status table.
  minColumns: 120,
  minRows: 40,
});

export const tuiTheme = Object.freeze({
  name: "mise",
  black: "#1a1a1a",
  red: "#e5534b",
  green: "#57ab5a",
  yellow: "#c69026",
  blue: "#539bf5",
  magenta: "#b083f0",
  cyan: "#39c5cf",
  white: "#adbac7",
  brightBlack: "#636e7b",
  brightRed: "#ff938a",
  brightGreen: "#6bc46d",
  brightYellow: "#daaa3f",
  brightBlue: "#6cb6ff",
  brightMagenta: "#dcbdfb",
  brightCyan: "#56d4dd",
  brightWhite: "#cdd9e5",
  background: tuiTerminal.background,
  foreground: "#d4d4d4",
  selection: "#333333",
  cursor: "#d4d4d4",
});

// The framed window composed around the terminal frames.
export const tuiCanvas = Object.freeze({
  margin: 24,
  titleBar: 36,
  captionBar: 76,
  get width() {
    return tuiTerminal.width + this.margin * 2;
  },
  get height() {
    return this.margin + this.titleBar + tuiTerminal.height + this.captionBar;
  },
  get terminalX() {
    return this.margin;
  },
  get terminalY() {
    return this.margin + this.titleBar;
  },
});

// Six demo agents. Claude stays blocked from the start; starting at step 278
// lets Gemini's first session end (step 299) before the freezer scene, and
// Codex plate its work mid-tour, so every view shows real state changes.
export const tuiDemoEnvironment = Object.freeze({
  HERDR_MISE_DEMO_COUNT: "6",
  HERDR_MISE_DEMO_START_STEP: "278",
});

// Keys use VHS command names. `expect` is a multiline regular expression the
// real terminal text must match during the scene; checkpoints are matched in
// storyboard order against VHS's per-command text snapshots. Every scene closes the previous overlay before
// opening the next: Escape is only pressed while a selection, help, or the
// freezer is open, because an unqualified Escape in the kitchen quits.
export const tuiStoryboard = Object.freeze([
  {
    start: 0,
    end: 4,
    scene: "kitchen",
    expect: "Workspace: All[\\s\\S]*f freezer",
    keys: [],
    caption: "Six coding agents, one kitchen: working, idle, blocked, plated.",
  },
  {
    start: 4,
    end: 8,
    scene: "blocked",
    expect: "^\\S?>!\\s*Claude\\b",
    keys: ["b"],
    caption: "Jump straight to the cook blocked at the pass.",
  },
  {
    start: 8,
    end: 12,
    scene: "stations",
    expect: "^\\S?>\\s+Hermes\\b",
    keys: ["Tab"],
    caption: "Walk the stations: state, workspace, time in state.",
  },
  {
    start: 12,
    end: 16,
    scene: "help",
    expect: "Esc close / leave / quit",
    keys: ["Escape", "?"],
    caption: "Every key in one place. Nothing here controls an agent.",
  },
  {
    start: 16,
    end: 20,
    scene: "recap",
    expect: "SERVICE RECAP",
    keys: ["Escape", "R"],
    caption: "Recap the service: observed time blocked, computed locally.",
  },
  {
    start: 20,
    end: 24,
    scene: "workspace",
    expect: "Workspace: checkout-api",
    keys: ["R", "w"],
    caption: "Focus one workspace; a returns to all of them.",
  },
  {
    start: 24,
    end: 28,
    scene: "freezer",
    expect: "WALK-IN FREEZER",
    keys: ["a", "f"],
    caption: "Open the walk-in freezer, where ended sessions rest.",
  },
  {
    start: 28,
    end: 30,
    scene: "return",
    expect: "Workspace: All[\\s\\S]*f freezer",
    keys: ["Escape"],
    caption: "Back to the kitchen. Read-only and localhost-only.",
  },
]);

const keyCommands = new Set(["Tab", "Escape", "Enter"]);
const keyLabels = { Tab: "Tab", Escape: "Esc", Enter: "Enter" };

/** Human-readable label for one storyboard key. */
export function keyLabel(key) {
  return keyLabels[key] ?? key;
}

// Each scene's caption appears this long before its first key, and keys
// inside one scene are spaced so a viewer sees each one land.
export const TUI_KEY_LEAD_SECONDS = 0.5;
export const TUI_KEY_GAP_SECONDS = 0.4;

/**
 * Validate a contiguous, ordered storyboard covering exactly the tour
 * duration with captions and known keys.
 */
export function validateTuiStoryboard(value = tuiStoryboard) {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("tui storyboard: expected a non-empty cue list");
  let expectedStart = 0;
  const scenes = new Set();
  value.forEach((cue, index) => {
    const label = `tui storyboard[${index}]`;
    if (cue.start !== expectedStart)
      throw new Error(`${label}: expected start ${expectedStart}`);
    if (!(cue.end > cue.start))
      throw new Error(`${label}: end must be after start`);
    if (typeof cue.scene !== "string" || !/^[a-z][a-z-]*$/.test(cue.scene))
      throw new Error(`${label}: scene must be a lowercase id`);
    if (scenes.has(cue.scene))
      throw new Error(`${label}: duplicate scene ${cue.scene}`);
    scenes.add(cue.scene);
    if (typeof cue.caption !== "string" || cue.caption.trim() === "")
      throw new Error(`${label}: caption is required`);
    if (/["`\n]/.test(cue.caption))
      throw new Error(`${label}: caption must be a single unquoted line`);
    if (typeof cue.expect !== "string" || cue.expect === "")
      throw new Error(`${label}: expect checkpoint is required`);
    try {
      new RegExp(cue.expect, "m");
    } catch {
      throw new Error(`${label}: expect is not a valid pattern`);
    }
    if (!Array.isArray(cue.keys))
      throw new Error(`${label}: keys must be an array`);
    for (const key of cue.keys)
      if (!keyCommands.has(key) && !/^[a-zA-Z?]$/.test(key))
        throw new Error(`${label}: unsupported key ${JSON.stringify(key)}`);
    if (index > 0 && cue.keys.length === 0)
      throw new Error(`${label}: every scene after the first presses a key`);
    if (
      TUI_KEY_LEAD_SECONDS + cue.keys.length * TUI_KEY_GAP_SECONDS >=
      cue.end - cue.start
    )
      throw new Error(`${label}: too many keys for the scene duration`);
    expectedStart = cue.end;
  });
  if (expectedStart !== TUI_DEMO_DURATION_SECONDS)
    throw new Error(
      `tui storyboard: expected to end at ${TUI_DEMO_DURATION_SECONDS}s, got ${expectedStart}s`,
    );
  return value;
}

// Tape strings are double-quoted and shell commands single-quote paths.
function tapePath(path) {
  if (typeof path !== "string" || !path.startsWith("/"))
    throw new Error(`tape path must be absolute: ${path}`);
  if (/["'`\\\n$]/.test(path))
    throw new Error(`tape path has unsupported characters: ${path}`);
  return path;
}

const seconds = (value) => `${Number(value.toFixed(2))}s`;

/**
 * Generate the VHS tape. Setup, the grid probe, startup, and shutdown stay
 * hidden; the visible recording is exactly the storyboard.
 *
 * @param {{ frameDir: string, gridPath: string, binary: string,
 *   socketPath: string, port: number }} options
 */
export function tuiTape(
  { frameDir, textPath, gridPath, binary, socketPath, port },
  storyboard = tuiStoryboard,
) {
  if (!tapePath(textPath).endsWith(".ascii"))
    throw new Error(`text snapshot path must end in .ascii: ${textPath}`);
  validateTuiStoryboard(storyboard);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(`invalid port: ${port}`);
  const env = {
    HERDR_SOCKET_PATH: tapePath(socketPath),
    HERDR_MISE_PORT: String(port),
    ...tuiDemoEnvironment,
  };
  const launch = [
    `stty size > '${tapePath(gridPath)}';`,
    "exec env",
    ...Object.entries(env).map(([key, value]) => `${key}='${value}'`),
    `'${tapePath(binary)}' --tui`,
  ].join(" ");
  const lines = [
    "# Generated by scripts/capture-tui-media.mjs from scripts/tui-demo-config.mjs.",
    `Output "${tapePath(frameDir).replace(/\/?$/, "/")}"`,
    `Output "${textPath}"`,
    'Set Shell "bash"',
    `Set FontFamily "${tuiTerminal.fontFamily}"`,
    `Set FontSize ${tuiTerminal.fontSize}`,
    `Set LineHeight ${tuiTerminal.lineHeight}`,
    `Set LetterSpacing ${tuiTerminal.letterSpacing}`,
    `Set Width ${tuiTerminal.width}`,
    `Set Height ${tuiTerminal.height}`,
    `Set Padding ${tuiTerminal.padding}`,
    `Set Framerate ${TUI_FRAME_RATE}`,
    "Set TypingSpeed 0",
    `Set Theme ${JSON.stringify(tuiTheme)}`,
    "Hide",
    `Type "${launch}"`,
    "Enter",
    "Wait+Screen@15s /DEMO SERVICE/",
    "Sleep 1s",
    "Show",
  ];
  for (const cue of storyboard) {
    let elapsed = 0;
    cue.keys.forEach((key, index) => {
      const pause = index === 0 ? TUI_KEY_LEAD_SECONDS : TUI_KEY_GAP_SECONDS;
      lines.push(`Sleep ${seconds(pause)}`);
      elapsed += pause;
      lines.push(keyCommands.has(key) ? key : `Type "${key}"`);
    });
    lines.push(`Sleep ${seconds(cue.end - cue.start - elapsed)}`);
  }
  lines.push("Hide", 'Type "q"', "Sleep 500ms", "");
  return lines.join("\n");
}

// VHS separates its per-command text snapshots with a line of 80 dashes; the
// TUI's own borders always carry corners or titles, so they never match.
const snapshotSeparator = /^─{80}$/m;

/**
 * Match each scene's checkpoint, in storyboard order, against VHS text
 * snapshots of the real terminal. Returns the snapshot index per scene.
 */
export function verifyTuiCheckpoints(text, storyboard = tuiStoryboard) {
  const snapshots = String(text ?? "").split(snapshotSeparator);
  const matched = {};
  let index = 0;
  for (const cue of storyboard) {
    const pattern = new RegExp(cue.expect, "m");
    while (index < snapshots.length && !pattern.test(snapshots[index])) index++;
    if (index === snapshots.length)
      throw new Error(
        `TUI scene "${cue.scene}" never showed /${cue.expect}/ in the recorded terminal`,
      );
    matched[cue.scene] = index;
  }
  return matched;
}

const timestamp = (value) => {
  const total = Math.round(value * 1000);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
};

const keysText = (cue) =>
  cue.keys.length ? `[${cue.keys.map(keyLabel).join(" ")}] ` : "";

/** WebVTT captions: one cue per scene, prefixed with the keys pressed. */
export function tuiWebVtt(storyboard = tuiStoryboard) {
  validateTuiStoryboard(storyboard);
  const cues = storyboard.map(
    (cue, index) =>
      `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${keysText(cue)}${cue.caption}`,
  );
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

const clock = (value) =>
  `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;

/** Plain-text transcript matching the product feature-loop format. */
export function tuiTranscript(label, storyboard = tuiStoryboard) {
  validateTuiStoryboard(storyboard);
  const lines = storyboard.map(
    (cue) =>
      `${clock(cue.start)}–${clock(cue.end)}  ${keysText(cue)}${cue.caption}`,
  );
  return [
    "Terminal UI tour",
    label,
    `${TUI_DEMO_DURATION_SECONDS}s · ${TUI_FRAME_RATE} fps · ${tuiCanvas.width}×${tuiCanvas.height}`,
    "",
    ...lines,
    "",
  ].join("\n");
}

validateTuiStoryboard();
