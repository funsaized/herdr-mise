/** Acceptance of receipts emitted only after the trusted GitHub gate validates. */
import { z } from "npm:zod@4.4.3";
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().regex(/^[1-9][0-9]*$/);
const Receipt = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.literal("funsaized/herdr-mise"),
    prNumber: z.number().int().positive(),
    headSha: Sha,
    baseSha: Sha,
    controlSha: Sha,
    gateRunId: Id,
    gateRunAttempt: Id,
    producerRunId: Id,
    producerWorkflowPath: z.literal(
      ".github/workflows/swamp-managed-verification.yml",
    ),
    actor: z.string().min(1),
    trustBoundary: z.boolean(),
    verifiedAt: z.iso.datetime(),
    policySha256: Digest,
    workflowSha256: Digest,
    manifestSha256: Digest,
  })
  .strict();

export function validateManagedReceipt(
  value: unknown,
  expected: {
    prNumber: number;
    headSha: string;
    baseSha: string;
    policySha256: string;
    workflowSha256: string;
    gateRunId: string;
    maxAgeHours: number;
  },
  gate: {
    id: number;
    workflow_id: number;
    head_sha: string;
    event: string;
    head_branch: string;
    status: string;
    conclusion: string;
    run_attempt: number;
    repository: { full_name: string };
  },
  workflow: { id: number; path: string },
  producer: {
    id: number;
    head_sha: string;
    event: string;
    head_branch: string;
    status: string;
    conclusion: string;
    actor: { login: string };
    triggering_actor?: { login: string };
    path: string;
    repository: { full_name: string };
  },
  now = Date.now(),
) {
  const receipt = Receipt.parse(value);
  if (
    receipt.prNumber !== expected.prNumber ||
    receipt.headSha !== expected.headSha ||
    receipt.baseSha !== expected.baseSha ||
    receipt.controlSha !== expected.baseSha ||
    receipt.policySha256 !== expected.policySha256 ||
    receipt.workflowSha256 !== expected.workflowSha256 ||
    receipt.gateRunId !== expected.gateRunId
  )
    throw new Error(
      "Managed receipt does not match current candidate, base, controls or policy",
    );
  if (
    String(gate.id) !== receipt.gateRunId ||
    String(gate.run_attempt) !== receipt.gateRunAttempt ||
    gate.repository.full_name !== receipt.repository ||
    gate.workflow_id !== workflow.id ||
    workflow.path !== ".github/workflows/swamp-managed-gate.yml" ||
    gate.head_sha !== receipt.controlSha ||
    gate.event !== "workflow_run" ||
    gate.head_branch !== "main" ||
    gate.status !== "completed" ||
    gate.conclusion !== "success"
  )
    throw new Error(
      "Managed receipt did not originate in the successful trusted gate",
    );
  if (
    String(producer.id) !== receipt.producerRunId ||
    producer.repository.full_name !== receipt.repository ||
    producer.head_sha !== receipt.controlSha ||
    producer.event !== "workflow_dispatch" ||
    producer.head_branch !== "main" ||
    producer.status !== "completed" ||
    producer.conclusion !== "success" ||
    producer.path !== receipt.producerWorkflowPath ||
    (producer.triggering_actor ?? producer.actor).login !== receipt.actor
  )
    throw new Error("Managed receipt producer identity does not match");
  if (receipt.trustBoundary && receipt.actor !== "funsaized")
    throw new Error("Trust-boundary receipt requires the owner dispatcher");
  const age = now - Date.parse(receipt.verifiedAt);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(expected.maxAgeHours) ||
    expected.maxAgeHours <= 0 ||
    age < 0 ||
    age > expected.maxAgeHours * 3600000
  )
    throw new Error("Managed receipt is stale or from the future");
  return receipt;
}
