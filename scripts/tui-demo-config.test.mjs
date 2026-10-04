import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCaptureTools, verifyCommittedSource } from "./capture-media.mjs";
import {
  USAGE,
  buildRelease,
  captureTui,
  compositionFilter,
  fontInstalled,
  parseGrid,
  preflight,
  rawFrames,
  recordTui,
} from "./capture-tui-media.mjs";
import { ffmpegAvailable, validateTuiMedia } from "./check-tui-media.mjs";
import {
  TUI_DEMO_CAPTURE_PATH,
  TUI_DEMO_DURATION_SECONDS,
  TUI_FRAME_RATE,
  TUI_POSTER_SECONDS,
  tuiOutputs,
  tuiStoryboard,
  tuiTape,
  tuiTerminal,
  tuiTranscript,
  tuiWebVtt,
  validateTuiStoryboard,
  verifyTuiCheckpoints,
} from "./tui-demo-config.mjs";

const tapeOptions = {
  frameDir: "/capture/frames",
  textPath: "/capture/terminal.ascii",
  gridPath: "/capture/grid.txt",
  binary: "/repo/target/release/herdr-mise",
  socketPath: "/capture/no-herdr.sock",
  port: 24555,
};

// Terminal text a real recording shows for each scene, as VHS snapshots.
const sceneText = {
  kitchen: "│▀Mock feed · Workspace: All▀│\n│ w scope · a all · f freezer │",
  blocked: "│>! Claude      Unavailable payments │",
  stations: "│>  Hermes      Unavailable order-routing │",
  help: "│ Esc close / leave / quit │",
  recap: "┌ SERVICE RECAP ──┐",
  workspace: "│▀Mock feed · Workspace: checkout-api▀│",
  freezer: "WALK-IN FREEZER · Workspace: All · f kitchen",
  return: "│▀Mock feed · Workspace: All▀│\n│ f freezer · q quit │",
};
const snapshots = (scenes) =>
  ["hidden shell", ...scenes.map((scene) => sceneText[scene])].join(
    `\n${"─".repeat(80)}\n`,
  );
const allScenes = tuiStoryboard.map((cue) => cue.scene);

// Mirrors the kitchen key handling in server/src/tui/mod.rs closely enough
// to prove the storyboard never presses a key that would quit the TUI.
function replay(storyboard) {
  const state = {
    selected: false,
    help: false,
    recap: false,
    view: "kitchen",
  };
  const views = [];
  for (const cue of storyboard) {
    for (const key of cue.keys) {
      if (state.recap) {
        assert.notEqual(key, "q", `${cue.scene}: q quits from the recap`);
        if (key === "R" || key === "Escape") state.recap = false;
        continue;
      }
      if (key === "R" && !state.help) {
        state.recap = true;
        continue;
      }
      if (key === "?") state.help = !state.help;
      else if (key === "Escape") {
        if (state.help) state.help = false;
        else if (state.selected) state.selected = false;
        else if (state.view === "freezer") state.view = "kitchen";
        else assert.fail(`${cue.scene}: Escape would quit the TUI`);
      } else if (key === "q") assert.fail(`${cue.scene}: q quits the TUI`);
      else if (key === "f")
        state.view = state.view === "freezer" ? "kitchen" : "freezer";
      else if (["b", "Tab"].includes(key)) state.selected = true;
    }
    views.push({ scene: cue.scene, ...state });
  }
  return views;
}

function visibleSeconds(tape) {
  const lines = tape.split("\n");
  const shown = lines.indexOf("Show");
  const hidden = lines.lastIndexOf("Hide");
  return lines
    .slice(shown, hidden)
    .map((line) => /^Sleep ([\d.]+)s$/.exec(line)?.[1])
    .filter(Boolean)
    .reduce((sum, value) => sum + Number(value), 0);
}

test("TUI storyboard generates contiguous captioned tape and transcripts", () => {
  validateTuiStoryboard();
  const views = replay(tuiStoryboard);
  const at = (scene) => views.find((view) => view.scene === scene);
  assert.equal(at("blocked").selected, true);
  assert.equal(at("help").help, true);
  assert.equal(at("recap").recap, true);
  assert.equal(at("freezer").view, "freezer");
  assert.deepEqual(views.at(-1), {
    scene: "return",
    selected: false,
    help: false,
    recap: false,
    view: "kitchen",
  });
  const poster = tuiStoryboard.find(
    (cue) => cue.start <= TUI_POSTER_SECONDS && TUI_POSTER_SECONDS < cue.end,
  );
  assert.equal(poster.scene, "blocked");

  for (const mutate of [
    (cues) => (cues[1].start += 1),
    (cues) => (cues[2].end = cues[2].start),
    (cues) => (cues[3].caption = " "),
    (cues) => (cues[3].caption = 'say "hi"'),
    (cues) => (cues[4].keys = ["F12"]),
    (cues) => (cues[4].keys = []),
    (cues) => (cues[5].keys = ["a", "a", "a", "a", "a", "a", "a", "a", "a"]),
    (cues) => (cues[6].scene = cues[5].scene),
    (cues) => delete cues[2].expect,
    (cues) => (cues[2].expect = "(unclosed"),
    (cues) => cues.pop(),
  ]) {
    const cues = structuredClone(tuiStoryboard);
    mutate(cues);
    assert.throws(() => validateTuiStoryboard(cues), /tui storyboard/);
  }

  const tape = tuiTape(tapeOptions);
  const lines = tape.split("\n");
  assert.ok(lines.includes('Output "/capture/frames/"'));
  assert.ok(lines.includes('Output "/capture/terminal.ascii"'));
  assert.ok(lines.includes(`Set FontFamily "${tuiTerminal.fontFamily}"`));
  assert.ok(lines.includes(`Set Framerate ${TUI_FRAME_RATE}`));
  // Setup, the grid probe, and startup are hidden; the tour starts on Show.
  const launch = lines.findIndex((line) => line.includes("--tui"));
  assert.ok(lines.indexOf("Hide") < launch);
  assert.ok(launch < lines.indexOf("Show"));
  assert.match(lines[launch], /stty size > '\/capture\/grid\.txt';/);
  assert.match(lines[launch], /HERDR_SOCKET_PATH='\/capture\/no-herdr\.sock'/);
  assert.match(lines[launch], /HERDR_MISE_DEMO_COUNT='6'/);
  assert.ok(
    lines.findIndex((line) => line.startsWith("Wait+Screen")) <
      lines.indexOf("Show"),
  );
  assert.ok(Math.abs(visibleSeconds(tape) - TUI_DEMO_DURATION_SECONDS) < 1e-9);
  const pressed = lines
    .slice(lines.indexOf("Show") + 1, lines.lastIndexOf("Hide"))
    .filter((line) => !line.startsWith("Sleep"))
    .map((line) => /^Type "(.)"$/.exec(line)?.[1] ?? line);
  assert.deepEqual(
    pressed,
    tuiStoryboard.flatMap((cue) => cue.keys),
  );
  // Quitting happens after the visible tour.
  assert.deepEqual(lines.slice(lines.lastIndexOf("Hide")), [
    "Hide",
    'Type "q"',
    "Sleep 500ms",
    "",
  ]);
  for (const bad of [
    { frameDir: "relative/frames" },
    { textPath: "/capture/terminal.txt" },
    { gridPath: "/capture/it's.txt" },
    { binary: '/repo/"bin"' },
    { port: 80 },
  ])
    assert.throws(() => tuiTape({ ...tapeOptions, ...bad }));

  const vtt = tuiWebVtt();
  assert.ok(vtt.startsWith("WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.000\n"));
  // One timing line per scene (counted without a regex over the cue arrow).
  assert.equal(
    vtt.split("\n").filter((line) => line.includes(" --> ")).length,
    tuiStoryboard.length,
  );
  assert.match(vtt, /00:00:28\.000 --> 00:00:30\.000\n\[Esc\] /);
  assert.match(vtt, /\[Esc \?\] Every key in one place/);
  const transcript = tuiTranscript("herdr-mise 0.4.0 · source abc1234");
  assert.match(
    transcript,
    /^Terminal UI tour\nherdr-mise 0\.4\.0 · source abc1234\n30s · 20 fps · \d+×\d+\n\n0:00–0:04  Six coding agents/,
  );
  assert.match(transcript, /0:24–0:28  \[a f\] Open the walk-in freezer/);

  // Checkpoints match real terminal text in storyboard order; TUI border
  // lines made of box-drawing dashes never split a snapshot.
  assert.deepEqual(
    Object.keys(verifyTuiCheckpoints(snapshots(allScenes))),
    allScenes,
  );
  assert.throws(
    () =>
      verifyTuiCheckpoints(snapshots(allScenes.filter((s) => s !== "help"))),
    /"help" never showed/,
  );
  assert.throws(
    () =>
      verifyTuiCheckpoints(
        snapshots(["kitchen", "stations", "blocked", ...allScenes.slice(3)]),
      ),
    /"stations" never showed/,
  );
  assert.throws(() => verifyTuiCheckpoints(""), /"kitchen" never showed/);

  const { graph, output } = compositionFilter(580);
  assert.match(graph, /setpts=N\/\(580\/30\)\/TB/);
  assert.equal(output, `[v${tuiStoryboard.length}]`);
  assert.match(graph, /enable='gte\(t,28\)\*lt\(t,30\)'/);
});

async function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function temporaryRepository() {
  const root = await mkdtemp(join(tmpdir(), "tui-capture-"));
  await mkdir(join(root, "server"));
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "server/Cargo.toml"),
    '[package]\nname = "herdr-mise-server"\nversion = "0.4.0"\n',
  );
  await writeFile(join(root, "scripts/tui-demo-config.mjs"), "// config\n");
  await writeFile(join(root, ".gitignore"), "/docs/assets/.capture-tui-*/\n");
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "fixture",
  );
  return root;
}

const okTools = {
  run: () => "tool 1.0",
  encode: () => {},
  probe: () => ({}),
  digest: async () => "0".repeat(64),
};

test("TUI capture rejects invalid usage dirty source and missing prerequisites", async () => {
  const shell = spawnSync("/bin/bash", ["scripts/capture-demo.sh", "nope"], {
    encoding: "utf8",
  });
  assert.equal(shell.status, 64);
  assert.match(shell.stderr, /capture-demo\.sh tui\|web/);
  const script = resolve("scripts/capture-tui-media.mjs");
  const invalid = spawnSync(process.execPath, [script, "--bogus"], {
    encoding: "utf8",
  });
  assert.equal(invalid.status, 64);
  assert.equal(invalid.stderr.trim(), USAGE);
  const help = spawnSync(process.execPath, [script, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.equal(help.stdout.trim(), USAGE);

  const root = await temporaryRepository();
  try {
    await writeFile(join(root, "untracked.txt"), "dirty");
    let ran = false;
    await assert.rejects(
      captureTui(root, {
        tools: { ...okTools, run: () => (ran = true) },
      }),
      /clean committed source tree/,
    );
    assert.equal(ran, false, "no tool runs for a dirty checkout");
    assert.equal(existsSync(join(root, "docs")), false);
  } finally {
    await rm(root, { recursive: true });
  }

  const fakeFfmpeg = (missing) => ({
    ...okTools,
    run(command, args) {
      if (command === missing) throw new Error("ENOENT");
      if (args.includes("-encoders"))
        return missing === "libx264"
          ? " V..... libvpx-vp9"
          : " libx264 libvpx-vp9";
      if (args.includes("-filters"))
        return missing === "palettegen"
          ? " overlay paletteuse "
          : " overlay palettegen paletteuse ";
      return `${command} version 1`;
    },
  });
  const hasFont = () => true;
  assert.equal(preflight(fakeFfmpeg(null), { hasFont }).vhs, "vhs version 1");
  assert.throws(
    () => preflight(fakeFfmpeg("vhs"), { hasFont }),
    /vhs is required \(brew install vhs\)/,
  );
  assert.throws(
    () => preflight(fakeFfmpeg("gifsicle"), { hasFont }),
    /gifsicle is required/,
  );
  assert.throws(
    () => preflight(fakeFfmpeg("libx264"), { hasFont }),
    /libx264 encoder/,
  );
  assert.throws(
    () => preflight(fakeFfmpeg("palettegen"), { hasFont }),
    /palettegen filter/,
  );
  assert.throws(
    () => preflight(fakeFfmpeg(null), { hasFont: () => false }),
    /Menlo font is required/,
  );

  assert.deepEqual(parseGrid("45 126\n"), { rows: 45, columns: 126 });
  assert.throws(() => parseGrid("24 80\n"), /compact table/);
  assert.throws(() => parseGrid(""), /could not read the terminal grid/);
});

function stagingDirectories(root) {
  const assets = join(root, "docs/assets");
  return existsSync(assets)
    ? readdirSync(assets).filter((name) => name.startsWith(".capture-tui-"))
    : [];
}

function assertNothingPublished(root) {
  for (const spec of Object.values(tuiOutputs))
    assert.equal(existsSync(join(root, spec.path)), false, spec.path);
  assert.equal(existsSync(join(root, TUI_DEMO_CAPTURE_PATH)), false);
}

// A fake VHS run: writes the grid probe and `frames` raw text frames.
function fakeRecorder(
  frames,
  { skip = null, grid = "45 126\n", scenes = allScenes } = {},
) {
  return (args) => {
    const tape = readFileSync(args[0], "utf8");
    const frameDir = /^Output "(.*)\/"$/m.exec(tape)[1];
    writeFileSync(/stty size > '([^']+)'/.exec(tape)[1], grid);
    writeFileSync(/^Output "(.*\.ascii)"$/m.exec(tape)[1], snapshots(scenes));
    mkdirSync(frameDir, { recursive: true });
    for (let index = 1; index <= frames; index++)
      if (index !== skip)
        writeFileSync(
          join(frameDir, `frame-text-${String(index).padStart(5, "0")}.png`),
          "",
        );
  };
}

async function failingCapture({ recorder, encode, validate }) {
  const root = await temporaryRepository();
  const tools = {
    ...okTools,
    run(command, args) {
      if (command === "vhs") recorder(args);
      if (command === "gifsicle") writeFileSync(args.at(-1), "gif");
      return "";
    },
    encode(args) {
      encode?.(args);
      const target = args.at(-1);
      if (!target.includes("%")) writeFileSync(target, "media");
    },
    digest: async () => "1".repeat(64),
  };
  const error = await captureTui(root, {
    tools,
    preflight: () => ({}),
    freePort: async () => 24555,
    renderOverlays: async () => [],
    validate: validate ?? (async () => {}),
  }).then(
    () => null,
    (caught) => caught,
  );
  return { root, error };
}

test("TUI capture retains failed staging without publishing invalid media", async () => {
  const expected = TUI_DEMO_DURATION_SECONDS * TUI_FRAME_RATE;
  const cases = [
    // VHS reports success but writes nothing (the ffmpeg 9 failure mode).
    [{ recorder: fakeRecorder(0) }, /VHS produced no frames/],
    [
      { recorder: fakeRecorder(expected, { skip: 7 }) },
      /incomplete at frame 7/,
    ],
    [{ recorder: fakeRecorder(100) }, /captured 100 of 600 frames/],
    // The binary ran but never reached the freezer (a broken navigation key).
    [
      {
        recorder: fakeRecorder(expected, {
          scenes: allScenes.filter((scene) => scene !== "freezer"),
        }),
      },
      /"freezer" never showed/,
    ],
    [
      { recorder: fakeRecorder(expected, { grid: "30 100\n" }) },
      /falls? back to its compact table/,
    ],
    [
      {
        recorder: fakeRecorder(expected),
        encode: (args) => {
          if (args.includes("libvpx-vp9"))
            throw new Error("ffmpeg failed: vp9");
        },
      },
      /ffmpeg failed: vp9/,
    ],
    [
      {
        recorder: fakeRecorder(expected),
        validate: (root, metadata) =>
          validateTuiMedia(root, metadata, {
            digest: async () => "1".repeat(64),
            probe: () => ({
              streams: [{ codec_type: "audio" }],
              format: { duration: 30 },
            }),
            decode: null,
          }),
      },
      /must not contain audio|does not match its recorded hash|size mismatch|captions|budget/,
    ],
    [
      {
        recorder: fakeRecorder(expected),
        validate: () => {
          throw new Error("decode failed: truncated");
        },
      },
      /decode failed/,
    ],
  ];
  for (const [options, pattern] of cases) {
    const { root, error } = await failingCapture(options);
    try {
      assert.ok(error, `expected failure matching ${pattern}`);
      assert.match(error.message, pattern);
      assertNothingPublished(root);
      const [staging] = stagingDirectories(root);
      assert.ok(staging, "failed staging is retained");
      const retained = join(root, "docs/assets", staging);
      assert.ok(existsSync(join(retained, "tui-demo.tape")));
      assert.ok(existsSync(join(retained, "vhs.log")));
      // Retained staging is ignored, so the checkout stays clean.
      assert.equal(typeof verifyCommittedSource(root), "string");
    } finally {
      await rm(root, { recursive: true });
    }
  }
  assert.throws(() => rawFrames("/nonexistent/frames"), /no frames/);
});

function realRecorderAvailable() {
  const runnable = ["vhs", "ffmpeg", "ffprobe", "gifsicle", "cargo"].every(
    (tool) =>
      !spawnSync(
        tool,
        [tool === "ffmpeg" || tool === "ffprobe" ? "-version" : "--version"],
        {
          stdio: "ignore",
        },
      ).error,
  );
  return runnable && fontInstalled(tuiTerminal.fontFamily);
}

// Real boundary: the release binary driven by VHS through the storyboard,
// Playwright overlays, and ffmpeg encoding into an isolated repository, then
// validated with real ffprobe and full decodes. Runs where the recorder
// toolchain exists (the maintainer capture host); CI lacks VHS and ffmpeg.
async function realCaptureRoundTrip(t) {
  const { chromium } = await import("@playwright/test");
  if (!realRecorderAvailable() || !existsSync(chromium.executablePath())) {
    t.diagnostic("real TUI capture skipped: recorder toolchain unavailable");
    return;
  }
  const repository = resolve(".");
  const binary = buildRelease(repository, createCaptureTools(repository));
  const root = await temporaryRepository();
  try {
    const head = verifyCommittedSource(root);
    const metadata = await captureTui(root, { build: () => binary });
    assert.equal(metadata.sourceCommit, head);
    await validateTuiMedia(root, metadata);
    assert.deepEqual(Object.keys(metadata.recorder.checkpoints), allScenes);
    assert.ok(metadata.recorder.grid.columns >= tuiTerminal.minColumns);
    assert.deepEqual(stagingDirectories(root), [], "staging is cleaned up");

    // Breaking the binary launch publishes nothing and keeps the staging.
    await git(root, "add", ".");
    await git(
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-qm",
      "published capture",
    );
    const before = await readFile(join(root, TUI_DEMO_CAPTURE_PATH), "utf8");
    await assert.rejects(
      captureTui(root, { build: () => "/usr/bin/false" }),
      /vhs failed|grid|no frames|never showed/,
    );
    assert.equal(
      await readFile(join(root, TUI_DEMO_CAPTURE_PATH), "utf8"),
      before,
    );
    assert.equal(stagingDirectories(root).length, 1);

    // Disabling a navigation key (no `f`) is caught in the real terminal.
    const staging = await mkdtemp(join(tmpdir(), "tui-no-freezer-"));
    try {
      const storyboard = tuiStoryboard.map((cue) =>
        cue.scene === "freezer" ? { ...cue, keys: ["a"] } : cue,
      );
      await assert.rejects(
        recordTui({
          tools: createCaptureTools(repository),
          staging,
          binary,
          port: 24000 + (process.pid % 1000),
          storyboard,
        }),
        /"freezer" never showed/,
      );
    } finally {
      await rm(staging, { recursive: true });
    }
  } finally {
    await rm(root, { recursive: true });
  }
}

test("TUI provenance matches the storyboard and checked-in media", async (t) => {
  const root = resolve(".");
  const metadata = JSON.parse(
    await readFile(join(root, TUI_DEMO_CAPTURE_PATH), "utf8"),
  );
  // Hashes, sizes, captions, transcript, and budget always; codecs,
  // dimensions, duration, audio absence, and a full decode where ffmpeg exists.
  const media = ffmpegAvailable() ? {} : { probe: null, decode: null };
  await validateTuiMedia(root, metadata, media);
  assert.deepEqual(metadata.storyboard, tuiStoryboard);
  assert.ok(metadata.recorder.grid.columns >= tuiTerminal.minColumns);
  assert.ok(metadata.recorder.grid.rows >= tuiTerminal.minRows);

  for (const mutate of [
    (m) => (m.storyboard[0].caption = "different"),
    (m) => (m.outputs.webm.sha256 = "0".repeat(64)),
    (m) => (m.outputs.gif.bytes += 1),
    (m) => (m.schema = "demo-capture-v1"),
    (m) => (m.output.sha256 = "0".repeat(64)),
    (m) => delete m.recorder.grid,
    (m) => delete m.recorder.checkpoints.freezer,
    (m) => (m.recorder.checkpoints.return = 0),
  ]) {
    const bad = structuredClone(metadata);
    mutate(bad);
    await assert.rejects(
      validateTuiMedia(root, bad, { probe: null, decode: null }),
    );
  }

  await realCaptureRoundTrip(t);
});
