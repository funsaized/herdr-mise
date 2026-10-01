import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  PRODUCT_DEMO_SCHEMA,
  PRODUCT_DEMO_PROVENANCE,
  TUI_DEMO_INPUT,
  cuesFor,
  deliverables,
  frameRate,
  outputDimensions,
  readSourceVersion,
  sourceDimensions,
  storyboard,
  transcript,
  validateStoryboard,
  versionLabel,
  webVtt,
} from "./product-demo-config.mjs";
import { validateProductMedia } from "./check-product-media.mjs";

test("product storyboard covers seventy-five seconds and three bounded feature loops", () => {
  assert.equal(validateStoryboard(storyboard), storyboard);
  assert.deepEqual(
    storyboard.map((cue) => [cue.start, cue.end]),
    [
      [0, 10],
      [10, 20],
      [20, 32],
      [32, 44],
      [44, 56],
      [56, 66],
      [66, 75],
    ],
  );
  assert.equal(deliverables.length, 4);
  assert.equal(deliverables[0].durationSeconds, 75);
  assert.equal(deliverables[0].outputs.gif, undefined);
  assert.deepEqual(
    deliverables.slice(1).map((clip) => clip.durationSeconds),
    [22, 12, 12],
  );
  for (const clip of deliverables) {
    assert.equal(clip.end - clip.start, clip.durationSeconds);
    assert.ok(
      clip.posterSeconds >= 0 && clip.posterSeconds < clip.durationSeconds,
    );
    const cues = cuesFor(clip);
    assert.equal(cues[0].start, 0);
    assert.equal(cues.at(-1).end, clip.durationSeconds);
    if (clip.loop) assert.ok(clip.outputs.gif);
  }
  const names = deliverables.flatMap((clip) =>
    Object.values(clip.outputs).map((spec) => spec.path),
  );
  assert.equal(new Set(names).size, names.length);
  assert.ok(
    names.every((name) =>
      /^docs\/assets\/herdr-mise-(product-demo|feature-)/.test(name),
    ),
  );
  for (const bad of [
    [],
    storyboard.slice(0, -1),
    storyboard.map((cue, i) => (i === 1 ? { ...cue, start: 9 } : cue)),
    storyboard.map((cue, i) => (i === 0 ? { ...cue, caption: "" } : cue)),
  ])
    assert.throws(() => validateStoryboard(bad));
  assert.throws(() => cuesFor(deliverables[0], []));
});

test("product captions transcripts posters and version labels share the storyboard", async () => {
  const root = await mkdtemp(join(tmpdir(), "product-cues-"));
  try {
    const label = versionLabel(readSourceVersion(resolve(".")), "0123abc");
    const rendered = storyboard.map((cue) => ({
      ...cue,
      caption: cue.scene === "installation" ? label : cue.caption,
    }));
    for (const clip of deliverables) {
      const vtt = webVtt(clip, rendered),
        text = transcript(clip, label, rendered);
      await writeFile(join(root, `${clip.id}.vtt`), vtt);
      await writeFile(join(root, `${clip.id}.txt`), text);
      assert.match(vtt, /^WEBVTT\n\n1\n00:00:00.000 -->/);
      assert.ok(text.includes(label));
      const posterCue = cuesFor(clip, rendered).find(
        (cue) =>
          cue.start <= clip.posterSeconds && clip.posterSeconds < cue.end,
      );
      assert.ok(posterCue);
      assert.ok(vtt.includes(posterCue.text));
      assert.ok(text.includes(posterCue.text));
      assert.equal(await readFile(join(root, `${clip.id}.vtt`), "utf8"), vtt);
    }
    assert.throws(() => versionLabel("", "0123abc"));
    assert.throws(() => versionLabel("1.0", "bad"));
    assert.throws(() => transcript(deliverables[0], ""));
  } finally {
    await rm(root, { recursive: true });
  }
});

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function temporaryPackage(root) {
  await mkdir(join(root, "server"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "docs/assets"), { recursive: true });
  await cp("server/Cargo.toml", join(root, "server/Cargo.toml"));
  const version = readSourceVersion(root),
    sourceCommit = "a".repeat(40),
    label = versionLabel(version, sourceCommit);
  const rendered = storyboard.map((cue) => ({
    ...cue,
    caption: cue.scene === "installation" ? label : cue.caption,
  }));
  const metadata = {
    schema: PRODUCT_DEMO_SCHEMA,
    provenance: PRODUCT_DEMO_PROVENANCE,
    capturedAt: new Date().toISOString(),
    version,
    sourceCommit,
    versionLabel: label,
    frameRate,
    sourceDimensions,
    outputDimensions,
    storyboard: rendered,
    outputs: {},
    inputs: {},
  };
  const probes = new Map();
  for (const clip of deliverables) {
    const record = {
      kind: clip.kind,
      durationSeconds: clip.durationSeconds,
      posterSeconds: clip.posterSeconds,
      cues: cuesFor(clip, rendered),
      assets: {},
    };
    for (const [format, spec] of Object.entries(clip.outputs)) {
      const bytes =
        format === "vtt"
          ? webVtt(clip, rendered)
          : format === "txt"
            ? transcript(clip, label, rendered)
            : "fake media";
      const path = join(root, spec.path);
      await writeFile(path, bytes);
      record.assets[format] = {
        path: spec.path,
        codec: spec.codec,
        bytes: Buffer.byteLength(bytes),
        sha256: hash(bytes),
        durationSeconds: spec.duration ? clip.durationSeconds : null,
      };
      probes.set(path, {
        streams: [
          { codec_type: "video", codec_name: spec.codec, ...outputDimensions },
        ],
        format: { duration: clip.durationSeconds },
      });
    }
    metadata.outputs[clip.id] = record;
  }
  const tuiBytes = "prerecorded",
    capture = {
      schema: "demo-capture-v1",
      source_sha256: "original-source",
      release_binary_sha256: "original-binary",
      output: {
        path: TUI_DEMO_INPUT.path,
        sha256: hash(tuiBytes),
        poster_sha256: "original-poster",
      },
    };
  const captureBytes = JSON.stringify(capture);
  await writeFile(join(root, TUI_DEMO_INPUT.path), tuiBytes);
  await writeFile(join(root, TUI_DEMO_INPUT.capturePath), captureBytes);
  metadata.inputs.tuiDemo = {
    ...TUI_DEMO_INPUT,
    provenance: "prerecorded demo footage",
    originalCapture: capture,
    bytes: tuiBytes.length,
    sha256: hash(tuiBytes),
    captureSha256: hash(captureBytes),
    sourceSha256: capture.source_sha256,
    releaseBinarySha256: capture.release_binary_sha256,
    posterSha256: capture.output.poster_sha256,
  };
  return {
    metadata,
    probes,
    io: {
      probe: (path) => probes.get(path),
      digest: async (path) => hash(await readFile(path)),
      commitExists: () => true,
    },
  };
}

async function publishingGuards() {
  for (const profile of ["web", "product"])
    for (const state of ["tracked", "untracked", "no-head", "clean"]) {
      const root = await mkdtemp(join(tmpdir(), "product-guard-"));
      try {
        await mkdir(join(root, "scripts"));
        await mkdir(join(root, "client/src"), { recursive: true });
        await cp(
          "client/src/attention-story.json",
          join(root, "client/src/attention-story.json"),
        );
        for (const file of [
          "capture-readme-media.mjs",
          "capture-media.mjs",
          "readme-media-config.mjs",
        ])
          await cp(`scripts/${file}`, join(root, "scripts", file));
        await writeFile(
          join(root, "scripts/capture-product-media.mjs"),
          'throw new Error("CAPTURE_DEPENDENCY_STARTED");',
        );
        await mkdir(join(root, "node_modules/@playwright/test"), {
          recursive: true,
        });
        await writeFile(
          join(root, "node_modules/@playwright/test/package.json"),
          JSON.stringify({ type: "module", exports: "./index.js" }),
        );
        await writeFile(
          join(root, "node_modules/@playwright/test/index.js"),
          'throw new Error("CAPTURE_DEPENDENCY_STARTED");',
        );
        await writeFile(join(root, ".gitignore"), "node_modules/\n");
        const git = (args) => {
          const result = spawnSync("git", args, {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Test",
              GIT_AUTHOR_EMAIL: "test@example.invalid",
              GIT_COMMITTER_NAME: "Test",
              GIT_COMMITTER_EMAIL: "test@example.invalid",
            },
          });
          assert.equal(result.status, 0, result.stderr);
        };
        git(["init", "--quiet"]);
        if (state !== "no-head") {
          git(["add", "."]);
          git([
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--quiet",
            "-m",
            "fixture",
          ]);
        }
        if (state === "tracked")
          await writeFile(join(root, ".gitignore"), "node_modules/\n# dirty\n");
        if (state === "untracked")
          await writeFile(
            join(root, "untracked-source.mjs"),
            "export const dirty = true;\n",
          );
        const result = spawnSync(
          process.execPath,
          [
            join(root, "scripts/capture-readme-media.mjs"),
            ...(profile === "product" ? ["--profile", "product"] : []),
          ],
          { cwd: root, encoding: "utf8" },
        );
        assert.notEqual(result.status, 0);
        if (state === "clean")
          assert.match(result.stderr, /CAPTURE_DEPENDENCY_STARTED/);
        else {
          assert.doesNotMatch(result.stderr, /CAPTURE_DEPENDENCY_STARTED/);
          assert.match(
            result.stderr,
            state === "no-head" ? /git failed/ : /clean committed source tree/,
          );
        }
        assert.ok(
          !(await readdir(root)).includes("docs"),
          `${profile}/${state} created output`,
        );
      } finally {
        await rm(root, { recursive: true });
      }
    }
  const helper = new URL("./capture-media.mjs", import.meta.url).href;
  // Fixed program text; the helper URL is passed as data (process.argv[1]),
  // never spliced into the evaluated code.
  const importGuard =
    "import child from 'node:child_process'; import fs from 'node:fs'; import promises from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; const fail=()=>{throw new Error('import side effect')}; for(const key of ['spawn','spawnSync','exec','execSync']) child[key]=fail; for(const key of ['writeFileSync','mkdirSync','mkdtempSync','rmSync','renameSync']) fs[key]=fail; for(const key of ['mkdir','mkdtemp','writeFile','rm','rename']) promises[key]=fail; syncBuiltinESMExports(); await import(process.argv[1]);";
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", importGuard, helper],
    { encoding: "utf8" },
  );
  assert.equal(imported.status, 0, imported.stderr);
}

test("product artifact validation rejects incomplete or inconsistent deliverables", async () => {
  await publishingGuards();
  const root = await mkdtemp(join(tmpdir(), "product-validation-"));
  try {
    const { metadata, io, probes } = await temporaryPackage(root);
    await validateProductMedia(root, metadata, io);
    const id = deliverables[0].id;
    const mutations = [
      (m) => {
        delete m.outputs[id];
      },
      (m) => {
        delete m.outputs[id].assets.poster;
      },
      (m) => {
        delete m.version;
      },
      (m) => {
        m.outputs[id].assets.mp4.sha256 = "wrong";
      },
      (m) => {
        m.outputs[id].cues[0].end = 76;
      },
      (m) => {
        m.storyboard[0].caption = "";
      },
      (m) => {
        m.inputs.tuiDemo.provenance = "live";
      },
      (m) => {
        m.outputs[id].posterSeconds = 99;
      },
    ];
    for (const mutate of mutations) {
      const bad = structuredClone(metadata);
      mutate(bad);
      await assert.rejects(validateProductMedia(root, bad, io));
    }
    await assert.rejects(
      validateProductMedia(root, metadata, {
        ...io,
        commitExists: () => false,
      }),
      /unavailable/,
    );
    const path = join(root, deliverables[0].outputs.mp4.path),
      original = structuredClone(probes.get(path));
    for (const change of [
      (p) => {
        p.streams[0].codec_name = "gif";
      },
      (p) => {
        p.streams[0].width = 1;
      },
      (p) => {
        p.format.duration = 80;
      },
    ]) {
      const bad = structuredClone(original);
      change(bad);
      probes.set(path, bad);
      await assert.rejects(validateProductMedia(root, metadata, io));
    }
    probes.set(path, original);
    for (const format of ["txt", "vtt", "poster", "mp4"]) {
      const file = join(root, deliverables[0].outputs[format].path),
        bytes = await readFile(file);
      await writeFile(file, "");
      await assert.rejects(
        validateProductMedia(root, metadata, io),
        /absent or empty/,
      );
      await rm(file);
      await assert.rejects(
        validateProductMedia(root, metadata, io),
        /absent or empty/,
      );
      await writeFile(file, bytes);
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("visual capture refuses a URL that another server already answers", async () => {
  const { createServer } = await import("node:http");
  const { startVisualServer } = await import("./capture-media.mjs");
  const stray = createServer((_request, response) => response.end("other"));
  await new Promise((resolveListen) =>
    stray.listen(0, "127.0.0.1", resolveListen),
  );
  const { port } = stray.address();
  try {
    await assert.rejects(
      startVisualServer(process.cwd(), `http://127.0.0.1:${port}`),
      /already serving/,
    );
  } finally {
    await new Promise((resolveClose) => stray.close(resolveClose));
  }
});
