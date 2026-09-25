import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Each checkout gets its own stable preview port so parallel worktrees (and
// parallel verification lanes) never contend for one fixed port. The value
// is derived from the checkout path, so the config and every worker agree.
function checkoutPort(): number {
  const configured = Number(process.env.HERDR_MISE_VISUAL_PORT);
  if (Number.isInteger(configured) && configured > 0) return configured;
  const digest = createHash("sha256").update(resolve(__dirname, "..")).digest();
  return 20_000 + (digest.readUInt16BE(0) % 20_000);
}

export const visualPort = checkoutPort();
export const visualOrigin = `http://127.0.0.1:${visualPort}`;
