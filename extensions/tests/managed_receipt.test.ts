import { validateManagedReceipt } from "../models/managed_receipt.ts";
const main = "a".repeat(40),
  head = "b".repeat(40),
  digest = "c".repeat(64);
const now = Date.parse("2026-09-20T12:00:00Z");
const receipt = {
  schemaVersion: 1,
  repository: "funsaized/herdr-mise",
  prNumber: 1,
  headSha: head,
  baseSha: main,
  controlSha: main,
  gateRunId: "10",
  gateRunAttempt: "1",
  producerRunId: "9",
  producerWorkflowPath: ".github/workflows/swamp-managed-verification.yml",
  actor: "funsaized",
  trustBoundary: true,
  verifiedAt: "2026-09-20T11:00:00Z",
  policySha256: digest,
  workflowSha256: digest,
  manifestSha256: digest,
};
const expected = {
  prNumber: 1,
  headSha: head,
  baseSha: main,
  policySha256: digest,
  workflowSha256: digest,
  gateRunId: "10",
  maxAgeHours: 24,
};
const gate = {
  id: 10,
  workflow_id: 8,
  head_sha: main,
  event: "workflow_run",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  repository: { full_name: "funsaized/herdr-mise" },
};
const workflow = { id: 8, path: ".github/workflows/swamp-managed-gate.yml" };
const producer = {
  id: 9,
  head_sha: main,
  event: "workflow_dispatch",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  actor: { login: "funsaized" },
  path: receipt.producerWorkflowPath,
  repository: gate.repository,
};

Deno.test("only a receipt from the successful trusted gate and producer is accepted", () => {
  validateManagedReceipt(receipt, expected, gate, workflow, producer, now);
  for (const change of [
    { headSha: main },
    { baseSha: head },
    { controlSha: head },
    { gateRunId: "11" },
    { policySha256: "d".repeat(64) },
    { workflowSha256: "d".repeat(64) },
    { actor: "someone" },
    { verifiedAt: "2026-09-18T12:00:00Z" },
    { verifiedAt: "2026-09-21T12:00:00Z" },
    { producerRunId: "11" },
    { gateRunAttempt: "2" },
    { trustBoundary: undefined },
  ]) {
    let failed = false;
    try {
      validateManagedReceipt(
        { ...receipt, ...change },
        expected,
        gate,
        workflow,
        producer,
        now,
      );
    } catch {
      failed = true;
    }
    if (!failed)
      throw new Error(`Unsafe receipt accepted: ${JSON.stringify(change)}`);
  }
});

Deno.test("green status cannot substitute an unrelated workflow, fork, failed gate or dispatcher", () => {
  const cases = [
    () =>
      validateManagedReceipt(
        receipt,
        expected,
        { ...gate, event: "pull_request" },
        workflow,
        producer,
        now,
      ),
    () =>
      validateManagedReceipt(
        receipt,
        expected,
        { ...gate, head_sha: head },
        workflow,
        producer,
        now,
      ),
    () =>
      validateManagedReceipt(
        receipt,
        expected,
        { ...gate, conclusion: "failure" },
        workflow,
        producer,
        now,
      ),
    () =>
      validateManagedReceipt(
        receipt,
        expected,
        gate,
        { ...workflow, path: ".github/workflows/ci.yml" },
        producer,
        now,
      ),
    () =>
      validateManagedReceipt(
        receipt,
        expected,
        gate,
        workflow,
        { ...producer, repository: { full_name: "fork/repo" } },
        now,
      ),
    () =>
      validateManagedReceipt(
        receipt,
        expected,
        gate,
        workflow,
        { ...producer, triggering_actor: { login: "someone" } },
        now,
      ),
    () =>
      validateManagedReceipt(
        receipt,
        { ...expected, baseSha: head },
        gate,
        workflow,
        producer,
        now,
      ),
  ];
  for (const run of cases) {
    let failed = false;
    try {
      run();
    } catch {
      failed = true;
    }
    if (!failed) throw new Error("Untrusted producer accepted");
  }
});
