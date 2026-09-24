import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseLastJson } from "./lib/swamp-test-process.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test(
  "abort cleanup calls the cleaner only for a workspace and records the actual result",
  { timeout: 90_000 },
  async () => {
    const repo = await mkdtemp(join(tmpdir(), "nightshift-cleanup-"));
    function run(args, input) {
      const result = spawnSync("swamp", [...args, "--json", "--no-color"], {
        cwd: repo,
        encoding: "utf8",
        input: input && JSON.stringify(input),
        timeout: 30_000,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return parseLastJson(result.stdout);
    }
    try {
      run(["repo", "init", "--tool", "none"]);
      await mkdir(join(repo, "extensions/models"), { recursive: true });
      await writeFile(
        join(repo, "extensions/models/cleanup_fixture.ts"),
        `
import { z } from "npm:zod@4.4.3";
export const model = {
  type: "@test/cleanup", version: "2026.09.24.1",
  globalArguments: z.object({}),
  resources: {
    cleanup: { description: "Cleanup result", schema: z.object({ removed: z.boolean(), preserved: z.boolean() }), lifetime: "1d", garbageCollection: 2 },
    evidence: { description: "Recorded outcome", schema: z.object({ status: z.string(), runId: z.string(), outputs: z.object({ cleanup: z.object({ removed: z.boolean(), preserved: z.boolean(), reason: z.string().optional() }) }) }), lifetime: "1d", garbageCollection: 2 },
  },
  methods: {
    cleanup_workspace: { description: "Fixture cleanup", arguments: z.object({ workItem: z.string(), subjectRoot: z.string().min(1) }), async execute(args, context) {
      return { dataHandles: [await context.writeResource("cleanup", "cleanup-" + args.workItem, { removed: true, preserved: true })] };
    } },
    record_evidence: { description: "Fixture record", arguments: z.object({ workItem: z.string(), name: z.string(), payload: z.object({ status: z.string(), runId: z.string(), outputs: z.object({ cleanup: z.object({ removed: z.boolean(), preserved: z.boolean(), reason: z.string().optional() }) }) }) }), async execute(args, context) {
      return { dataHandles: [await context.writeResource("evidence", "evidence-" + args.workItem + "-" + args.name, args.payload)] };
    } },
  },
};
`,
      );
      run(["model", "create", "@test/cleanup", "verification-source-git"]);
      run(["model", "create", "@test/cleanup", "cleanup-factory"]);
      await mkdir(join(repo, "workflows"), { recursive: true });
      await copyFile(
        join(root, "workflows/workflow-nightshift-cleanup.yaml"),
        join(repo, "workflows/workflow-nightshift-cleanup.yaml"),
      );
      run(["workflow", "validate", "nightshift-cleanup"]);
      for (const [workItem, subjectRoot, expected] of [
        ["901", join(repo, "workspace"), { removed: true, preserved: true }],
        [
          "902",
          "",
          {
            removed: false,
            preserved: false,
            reason: "workspace was never created",
          },
        ],
      ]) {
        const result = run(
          ["workflow", "run", "nightshift-cleanup", "--stdin"],
          {
            factory: "cleanup-factory",
            workItem,
            subjectRoot,
            evidenceName: "abort-cleanup-run",
          },
        );
        assert.equal(result.status, "succeeded");
        const evidence = run([
          "data",
          "get",
          "cleanup-factory",
          `evidence-${workItem}-abort-cleanup-run`,
        ]);
        assert.equal(evidence.content.status, "succeeded");
        assert.deepEqual(evidence.content.outputs.cleanup, expected);
        const cleanup = run([
          "data",
          "query",
          `modelName == "verification-source-git" && name == "cleanup-${workItem}"`,
        ]);
        assert.equal(cleanup.total, subjectRoot ? 1 : 0);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);
