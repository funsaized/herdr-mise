import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  parseLastJson,
  runJson,
  startServe,
  stopChild,
} from "./lib/swamp-test-process.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "scripts", "fixtures");
const maxBuffer = 32 * 1024 * 1024;

function run(repo, args, input) {
  const result = spawnSync("swamp", [...args, "--json", "--no-color"], {
    cwd: repo,
    encoding: "utf8",
    input,
    maxBuffer,
  });
  let json = parseLastJson(result.stdout || result.stderr);
  if (result.status !== 0 && result.stderr.includes("{")) {
    const error = parseLastJson(result.stderr);
    if (error.error) json = error;
  }
  return { ...result, json };
}

function expectOk(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.json;
}

function runRemote(repo, server, args, input) {
  return run(repo, [...args, "--server", server], input);
}

function runRemoteAsync(repo, server, args, input) {
  return runJson(
    "swamp",
    [...args, "--server", server, "--json", "--no-color"],
    { cwd: repo },
    input,
  );
}

async function stopServe(server) {
  await stopChild(server.child);
}

function create(repo, server, modelName, workItem) {
  return runRemote(repo, server, [
    "workflow",
    "run",
    "phase0-factory-instance-create",
    "--input",
    `modelName=${modelName}`,
    "--input",
    `workItem=${workItem}`,
  ]);
}

function method(repo, server, model, name, inputs = []) {
  return runRemote(repo, server, [
    "model",
    "method",
    "run",
    model,
    name,
    ...inputs.flatMap(([key, value]) => ["--input", `${key}=${value}`]),
  ]);
}

test(
  "software-factory runtime instances satisfy the isolated serve contract",
  { timeout: 240_000 },
  async () => {
    const repo = await mkdtemp(join(tmpdir(), "nightshift-factory-instance-"));
    let serve;
    try {
      expectOk(run(repo, ["repo", "init", "--tool", "none"]));

      const lock = JSON.parse(
        await readFile(
          join(root, "extensions", "models", "upstream_extensions.json"),
          "utf8",
        ),
      );
      await mkdir(join(repo, "extensions", "models"), { recursive: true });
      await writeFile(
        join(repo, "extensions", "models", "upstream_extensions.json"),
        `${JSON.stringify({ "@swamp/software-factory": lock["@swamp/software-factory"] }, null, 2)}\n`,
      );
      // Seed installed extension inputs (never runtime data) from a provisioned
      // checkout. Swamp still owns restoration and type/version validation.
      const provisionedRoot = process.env.SWAMP_TEST_EXTENSION_REPO ?? root;
      for (const path of lock["@swamp/software-factory"].files) {
        if (path.startsWith("/") || path.split("/").includes(".."))
          throw new Error("unsafe extension lock path");
        try {
          await mkdir(dirname(join(repo, path)), { recursive: true });
          await cp(join(provisionedRoot, path), join(repo, path), {
            recursive: true,
          });
        } catch (error) {
          if (error.code !== "ENOENT" || process.env.SWAMP_TEST_EXTENSION_REPO)
            throw error;
        }
      }
      expectOk(run(repo, ["extension", "install"]));
      const installed = expectOk(
        run(repo, ["model", "type", "describe", "@swamp/software-factory"]),
      );
      assert.equal(
        installed.version,
        lock["@swamp/software-factory"].version,
        "factory provisioning must resolve the pinned version before testing",
      );

      await mkdir(join(repo, "models", "@swamp", "software-factory"), {
        recursive: true,
      });
      await mkdir(join(repo, "workflows"), { recursive: true });
      await copyFile(
        join(fixtures, "factory-instance-template.yaml"),
        join(
          repo,
          "models",
          "@swamp",
          "software-factory",
          "phase0-factory-template.yaml",
        ),
      );
      await copyFile(
        join(fixtures, "factory-instance-create.yaml"),
        join(repo, "workflows", "workflow-phase0-factory-instance-create.yaml"),
      );
      await copyFile(
        join(fixtures, "factory-instance-repair.yaml"),
        join(repo, "workflows", "workflow-phase0-factory-instance-repair.yaml"),
      );

      expectOk(
        run(repo, ["workflow", "validate", "phase0-factory-instance-create"]),
      );
      expectOk(
        run(repo, ["workflow", "validate", "phase0-factory-instance-repair"]),
      );
      serve = await startServe(repo);

      expectOk(
        method(repo, serve.server, "phase0-factory-template", "validate"),
      );
      const started = expectOk(
        create(repo, serve.server, "phase0-runtime-main", "101"),
      );
      assert.equal(started.status, "succeeded");
      assert.equal(
        started.jobs[0].steps[0].assertResult.passed,
        true,
        "missing-model data.latest must return null",
      );

      const definition = expectOk(
        runRemote(repo, serve.server, ["model", "get", "phase0-runtime-main"]),
      );
      assert.equal(definition.name, "phase0-runtime-main");
      assert.match(definition.id, /^[0-9a-f-]{36}$/);
      assert.notEqual(definition.id, "e5ddf284-ed2c-48f2-a304-2163908c3082");
      assert.equal(
        definition.globalArguments.stages[0].work.workflow.inputs.factory,
        "${{ self.name }}",
      );
      assert.equal(
        definition.globalArguments.stages[0].work.workflow.inputs.workItem,
        "${{ self.workItem }}",
      );

      const status = expectOk(
        method(repo, serve.server, "phase0-runtime-main", "status", [
          ["workItem", "101"],
        ]),
      );
      assert.deepEqual(
        status.dataArtifacts[0].attributes.work.workflow.inputs,
        { factory: "phase0-runtime-main", workItem: "101" },
      );

      const same = await Promise.all([
        runRemoteAsync(repo, serve.server, [
          "workflow",
          "run",
          "phase0-factory-instance-create",
          "--input",
          "modelName=phase0-runtime-same",
          "--input",
          "workItem=201",
        ]),
        runRemoteAsync(repo, serve.server, [
          "workflow",
          "run",
          "phase0-factory-instance-create",
          "--input",
          "modelName=phase0-runtime-same",
          "--input",
          "workItem=201",
        ]),
      ]);
      assert.deepEqual(same.map(({ json }) => json.status).sort(), [
        "failed",
        "succeeded",
      ]);
      const sameState = expectOk(
        runRemote(repo, serve.server, [
          "data",
          "get",
          "phase0-runtime-same",
          "state-201",
        ]),
      );
      assert.equal(
        sameState.version,
        1,
        "concurrent duplicate intake must not reset state",
      );

      const cross = await Promise.all([
        runRemoteAsync(repo, serve.server, [
          "workflow",
          "run",
          "phase0-factory-instance-create",
          "--input",
          "modelName=phase0-runtime-a",
          "--input",
          "workItem=301",
        ]),
        runRemoteAsync(repo, serve.server, [
          "workflow",
          "run",
          "phase0-factory-instance-create",
          "--input",
          "modelName=phase0-runtime-b",
          "--input",
          "workItem=302",
        ]),
      ]);
      assert.deepEqual(
        cross.map(({ json }) => json.status),
        ["succeeded", "succeeded"],
      );
      const modelA = expectOk(
        runRemote(repo, serve.server, ["model", "get", "phase0-runtime-a"]),
      );
      const modelB = expectOk(
        runRemote(repo, serve.server, ["model", "get", "phase0-runtime-b"]),
      );
      assert.notEqual(modelA.id, modelB.id);

      const changed = structuredClone(definition.globalArguments);
      changed.stages[0].description = "unsafe-overwrite";
      const duplicate = run(
        repo,
        [
          "model",
          "@swamp/software-factory",
          "method",
          "run",
          "start",
          "phase0-runtime-main",
          "--stdin",
        ],
        JSON.stringify({ ...changed, workItem: "101" }),
      );
      assert.notEqual(duplicate.status, 0);
      assert.match(duplicate.json.error, /already has a run/);
      const overwritten = expectOk(
        runRemote(repo, serve.server, ["model", "get", "phase0-runtime-main"]),
      );
      assert.equal(overwritten.id, definition.id);
      assert.equal(
        overwritten.globalArguments.stages[0].description,
        "unsafe-overwrite",
        "globalArgs update occurs before duplicate start failure",
      );

      const repairedRun = expectOk(
        runRemote(repo, serve.server, [
          "workflow",
          "run",
          "phase0-factory-instance-repair",
          "--input",
          "modelName=phase0-runtime-main",
        ]),
      );
      assert.equal(repairedRun.status, "succeeded");
      const repaired = expectOk(
        runRemote(repo, serve.server, ["model", "get", "phase0-runtime-main"]),
      );
      assert.equal(repaired.id, definition.id);
      assert.equal(
        repaired.globalArguments.stages[0].description,
        "phase-zero-snapshot",
      );
      assert.equal(
        expectOk(
          runRemote(repo, serve.server, [
            "data",
            "get",
            "phase0-runtime-main",
            "state-101",
          ]),
        ).version,
        1,
      );

      for (const [name, payload, message] of [
        [
          "phase0-malformed",
          { stages: [], globalTransitions: [] },
          /at least 1|>=1/i,
        ],
        ["phase0-partial", { globalTransitions: [] }, /stages/i],
      ]) {
        const invalid = run(
          repo,
          [
            "model",
            "@swamp/software-factory",
            "method",
            "run",
            "validate",
            name,
            "--stdin",
          ],
          JSON.stringify(payload),
        );
        assert.notEqual(invalid.status, 0);
        assert.match(invalid.json.error, message);
        const before = expectOk(
          runRemote(repo, serve.server, ["model", "get", name]),
        );
        const after = expectOk(
          runRemote(repo, serve.server, ["model", "get", name]),
        );
        assert.deepEqual(
          after.globalArguments,
          before.globalArguments,
          "inspection must not mutate malformed definitions",
        );
        const repair = expectOk(
          runRemote(repo, serve.server, [
            "workflow",
            "run",
            "phase0-factory-instance-repair",
            "--input",
            `modelName=${name}`,
          ]),
        );
        assert.equal(repair.status, "succeeded");
        assert.equal(
          expectOk(runRemote(repo, serve.server, ["model", "get", name])).id,
          before.id,
        );
      }

      for (const [name, inputs] of [
        ["record_dispatch", [["workItem", "101"]]],
        ["record_artifact", []],
        [
          "advance",
          [
            ["workItem", "101"],
            ["transition", "finish"],
          ],
        ],
      ]) {
        const result =
          name === "record_artifact"
            ? runRemote(
                repo,
                serve.server,
                [
                  "model",
                  "method",
                  "run",
                  "phase0-runtime-main",
                  name,
                  "--stdin",
                ],
                JSON.stringify({
                  workItem: "101",
                  name: "summary",
                  payload: { text: "done" },
                }),
              )
            : method(repo, serve.server, "phase0-runtime-main", name, inputs);
        expectOk(result);
        const names = expectOk(
          runRemote(repo, serve.server, [
            "data",
            "query",
            'modelName == "phase0-runtime-main"',
            "--select",
            "name",
          ]),
        ).results;
        assert.equal(
          names.includes("report-swamp-software-factory-work-item-summary"),
          false,
          `${name} must not persist an empty summary report`,
        );
      }
      const summary = expectOk(
        method(repo, serve.server, "phase0-runtime-main", "summary", [
          ["workItem", "101"],
        ]),
      );
      assert.equal(
        summary.reports["@swamp/software-factory/work-item-summary"].json
          .runStatus,
        "terminal",
      );
      const report = expectOk(
        runRemote(repo, serve.server, [
          "report",
          "get",
          "@swamp/software-factory/work-item-summary",
          "--model",
          "phase0-runtime-main",
        ]),
      );
      assert.equal(report.version, 1);
      assert.equal(report.json.factoryName, "phase0-runtime-main");

      await stopServe(serve);
      serve = await startServe(repo);
      const persisted = expectOk(
        runRemote(repo, serve.server, ["model", "get", "phase0-runtime-main"]),
      );
      assert.equal(persisted.id, definition.id);
      assert.equal(
        expectOk(
          runRemote(repo, serve.server, [
            "data",
            "get",
            "phase0-runtime-main",
            "state-101",
          ]),
        ).content.status,
        "terminal",
      );
      assert.equal(
        expectOk(
          runRemote(repo, serve.server, [
            "report",
            "get",
            "@swamp/software-factory/work-item-summary",
            "--model",
            "phase0-runtime-main",
          ]),
        ).version,
        1,
      );
    } finally {
      if (serve) await stopServe(serve);
      await rm(repo, { recursive: true, force: true });
    }
  },
);
