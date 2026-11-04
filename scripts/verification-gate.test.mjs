import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  ".github/workflows/product-verification-gate.yml",
  "utf8",
);
const script = workflow
  .split("          script: |\n")[1]
  .split("\n")
  .map((line) => line.slice(12))
  .join("\n");
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  "github",
  "context",
  "core",
  script,
);

async function gate({
  name = "Product verification",
  path = ".github/workflows/product-verification.yml",
  current = "a".repeat(40),
  conclusion = "success",
  actor = "funsaized",
  draft = false,
  jobs = ["checks", "rust", "browser-and-package"].map((name) => ({
    name,
    conclusion: "success",
  })),
  headRepo = "funsaized/herdr-mise",
  changed = ["server/src/feed.rs"],
} = {}) {
  const writes = [];
  const run = {
    id: 1,
    workflow_id: 2,
    name,
    event: "pull_request",
    conclusion,
    head_sha: "a".repeat(40),
    head_branch: "change",
    head_repository: { id: 3, owner: { login: "funsaized" } },
  };
  const pr = {
    number: 4,
    draft,
    user: { login: actor },
    head: { sha: current, repo: { id: 3, full_name: headRepo } },
    base: { repo: { full_name: "funsaized/herdr-mise" } },
  };
  const pulls = { list: "prs", listFiles: "files" };
  const github = {
    rest: {
      actions: {
        listJobsForWorkflowRun: "jobs",
        getWorkflowRun: async () => ({ data: run }),
        getWorkflow: async () => ({ data: { path, name } }),
      },
      pulls,
      repos: {
        getContent: async () => ({
          data: {
            type: "file",
            size: 100,
            content: Buffer.from(
              JSON.stringify({
                codeOwner: "funsaized",
                trustBoundaryPaths: [".github/**"],
              }),
            ).toString("base64"),
          },
        }),
        createCommitStatus: async (value) => writes.push(value),
      },
    },
    paginate: async (route, options) => {
      if (route === "jobs") {
        assert.equal(options.filter, "latest");
        assert.equal(options.run_id, run.id);
      }
      return route === pulls.list
        ? [pr]
        : route === "jobs"
          ? jobs
          : changed.map((file) =>
              typeof file === "string" ? { filename: file } : file,
            );
    },
  };
  const core = { notice() {}, summary: { addRaw() {}, async write() {} } };
  await execute(
    github,
    {
      repo: { owner: "funsaized", repo: "herdr-mise" },
      payload: { workflow_run: { id: 1 } },
      serverUrl: "https://github.com",
      runId: 5,
    },
    core,
  );
  return writes;
}

test("trusted gate binds success to the verified current PR head and known executor identity", async () => {
  const [status] = await gate();
  assert.equal(status.state, "success");
  assert.equal(status.sha, "a".repeat(40));
  assert.equal(status.context, "Product verification");
  await assert.rejects(
    gate({ path: ".github/workflows/untrusted.yml" }),
    /does not identify/,
  );
  assert.deepEqual(await gate({ current: "b".repeat(40) }), []);
  assert.deepEqual(await gate({ conclusion: "cancelled" }), []);
});

test("trusted gate rejects failed execution and non-owner verification changes", async () => {
  assert.equal((await gate({ conclusion: "failure" }))[0].state, "failure");
  assert.equal(
    (
      await gate({
        actor: "contributor",
        changed: [".github/workflows/ci.yml"],
      })
    )[0].state,
    "failure",
  );
  assert.equal((await gate({ actor: "contributor" }))[0].state, "success");
});

test("trusted gate rejects a known path with a different workflow identity", async () => {
  await assert.rejects(
    gate({ name: "Unexpected executor" }),
    /does not identify/,
  );
});

test("draft success and draft-to-ready skipped jobs cannot certify a head", async () => {
  assert.deepEqual(await gate({ draft: true }), []);
  const jobs = ["checks", "rust", "browser-and-package"].map((name) => ({
    name,
    conclusion: "skipped",
  }));
  assert.deepEqual(await gate({ jobs }), []);
  assert.equal((await gate())[0].state, "success");
});

test("success requires every product job, including after partial reruns", async () => {
  for (const conclusion of ["skipped", "failure", "cancelled", null]) {
    assert.deepEqual(
      await gate({
        jobs: [
          { name: "checks", conclusion: "success" },
          { name: "rust", conclusion: "success" },
          { name: "browser-and-package", conclusion },
        ],
      }),
      [],
    );
  }
  assert.deepEqual(await gate({ jobs: [] }), []);
});

test("renamed protected paths and owner-authored forks remain protected", async () => {
  assert.equal(
    (
      await gate({
        actor: "contributor",
        changed: [
          {
            filename: "docs/moved.yml",
            previous_filename: ".github/workflows/ci.yml",
          },
        ],
      })
    )[0].state,
    "failure",
  );
  assert.equal(
    (
      await gate({
        headRepo: "fork/herdr-mise",
        changed: [".github/workflows/ci.yml"],
      })
    )[0].state,
    "failure",
  );
});
