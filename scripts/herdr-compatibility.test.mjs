import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditAdapterFixtureMappings,
  auditFixture,
  auditWorkflow,
  checkCompatibility,
} from "./check-herdr-compatibility.mjs";

const manifestPath = "compatibility/herdr.json";

test("compatibility manifest is the complete supported release authority", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(
    manifest.supported.map(({ release, protocol }) => ({ release, protocol })),
    [
      { release: "0.7.5", protocol: 17 },
      { release: "0.8.0", protocol: 19 },
    ],
  );
  assert.equal(
    new Set(manifest.supported.map((entry) => entry.release)).size,
    manifest.supported.length,
  );
  assert.equal(
    new Set(manifest.supported.map((entry) => entry.protocol)).size,
    manifest.supported.length,
  );
  for (const entry of manifest.supported) {
    assert.match(entry.upstreamCommit, /^[0-9a-f]{40}$/);
    assert.match(
      entry.fixture,
      /^server\/tests\/fixtures\/snapshot-herdr-[\w.-]+\.json$/,
    );
    const fixture = JSON.parse(readFileSync(entry.fixture, "utf8"));
    assert.equal(fixture.version, entry.release);
    assert.equal(fixture.protocol, entry.protocol);
  }
});

test("public compatibility tables are generated exactly from the manifest", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expected = manifest.supported
    .map((entry) => `| \`${entry.release}\` | \`${entry.protocol}\` |`)
    .join("\n");
  for (const path of ["README.md", "docs/operations.md"]) {
    const document = readFileSync(path, "utf8");
    const table = document.match(
      /<!-- herdr-compatibility:start -->[\s\S]*?\n([\s\S]*?)\n<!-- herdr-compatibility:end -->/,
    )?.[1];
    assert.ok(table, `${path} compatibility markers`);
    assert.equal(
      table,
      `| Herdr release | Snapshot protocol |\n|---|---|\n${expected}`,
    );
  }
});

test("adapter mapping audit rejects every manifest fixture absent from Rust cases", () => {
  const entries = [
    { fixture: "server/tests/fixtures/snapshot-herdr-0.7.5-p17.json" },
    { fixture: "server/tests/fixtures/snapshot-herdr-future.json" },
  ];
  const adapter =
    'include_str!("../tests/fixtures/snapshot-herdr-0.7.5-p17.json")';

  assert.deepEqual(auditAdapterFixtureMappings(entries, adapter), [
    "server/tests/fixtures/snapshot-herdr-future.json: adapter mapping case missing",
  ]);
});

test("fixture privacy audit rejects obvious private material", () => {
  assert.deepEqual(
    auditFixture({ pane_id: "fictional-pane", agent: "example-agent" }),
    [],
  );
  for (const unsafe of [
    { path: "/Users/alice/project" },
    { socket: "/tmp/herdr.sock" },
    { token: "secret-value" },
    { host: "devbox.internal" },
    { name: "alice@example.com" },
    { pane_id: "real-pane" },
  ]) {
    assert.ok(auditFixture(unsafe).length > 0, JSON.stringify(unsafe));
  }
});

test("fixture privacy audit rejects real workspace labels and session values", () => {
  assert.ok(auditFixture({ label: "Acme Production" }).length > 0);
  assert.ok(
    auditFixture({ agent_session: { value: "session-42" } }).length > 0,
  );
});

test("scheduled compatibility workflow is immutable, read-only, and non-publishing", () => {
  const workflow = readFileSync(
    ".github/workflows/herdr-compatibility-drift.yml",
    "utf8",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n  contents: read/);
  for (const { upstreamCommit } of manifest.supported)
    assert.ok(workflow.includes(`ref: ${upstreamCommit}`));
  assert.match(workflow, /npm run check:herdr-compatibility/);
  assert.doesNotMatch(workflow, /secrets\.|release|publish|git push|git tag/i);
});

test("workflow audit rejects privileged triggers and additional permission declarations", () => {
  const workflow = readFileSync(
    ".github/workflows/herdr-compatibility-drift.yml",
    "utf8",
  );
  const privilegedTrigger = workflow.replace(
    "  workflow_dispatch:",
    "  workflow_dispatch:\n  pull_request_target:",
  );
  const jobPermissions = workflow.replace(
    "  verify:\n",
    "  verify:\n    permissions:\n      contents: write\n",
  );
  const extraTopLevelPermission = workflow.replace(
    "permissions:\n  contents: read",
    "permissions:\n  contents: read\n  id-token: write",
  );
  const blankSeparatedPermission = workflow.replace(
    "permissions:\n  contents: read",
    "permissions:\n  contents: read\n\n  id-token: write",
  );

  assert.deepEqual(auditWorkflow(workflow), []);
  assert.ok(
    auditWorkflow(privilegedTrigger).includes(
      "compatibility workflow uses pull_request_target",
    ),
  );
  assert.ok(
    auditWorkflow(jobPermissions).includes(
      "compatibility workflow has additional permission declarations",
    ),
  );
  assert.ok(
    auditWorkflow(extraTopLevelPermission).includes(
      "compatibility workflow permissions are not exactly contents: read",
    ),
  );
  assert.ok(
    auditWorkflow(blankSeparatedPermission).includes(
      "compatibility workflow permissions are not exactly contents: read",
    ),
  );
});

test("upstream checker reads Cargo version, wire protocol, and SessionSnapshot schema from their real split sources", () => {
  const temp = mkdtempSync(join(tmpdir(), "herdr-compatibility-split-source-"));
  const entries = [
    { release: "0.7.5", protocol: 17 },
    { release: "0.8.0", protocol: 19 },
  ];
  try {
    const args = entries.map((entry) => {
      const directory = join(temp, entry.release);
      mkdirSync(join(directory, "src/protocol"), { recursive: true });
      mkdirSync(join(directory, "src/api/schema"), { recursive: true });
      writeFileSync(
        join(directory, "Cargo.toml"),
        `[package]\nname = "herdr"\nversion = "${entry.release}"\n`,
      );
      writeFileSync(
        join(directory, "src/protocol/wire.rs"),
        `pub const PROTOCOL_VERSION: u32 = ${entry.protocol};\n`,
      );
      writeFileSync(
        join(directory, "src/api/schema/session.rs"),
        `
pub struct SessionSnapshot {
    pub version: String,
    pub protocol: u32,
    pub workspaces: Vec<WorkspaceInfo>,
    pub tabs: Vec<TabInfo>,
    pub panes: Vec<PaneInfo>,
    pub layouts: Vec<PaneLayoutSnapshot>,
    pub agents: Vec<AgentInfo>,
}
`,
      );
      return `--upstream=${entry.release}=${directory}`;
    });
    assert.deepEqual(checkCompatibility(args), []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
