/** @type {readonly ["test-coverage", "security", "quality", "ui"]} */
export const REVIEW_LANES = ["test-coverage", "security", "quality", "ui"];
/** @typedef {typeof REVIEW_LANES[number]} Lane */
/** Lanes that run on every round; quality doubles as the generalist lane.
 * @type {Lane[]} */
export const MANDATORY_LANES = ["test-coverage", "security", "quality"];
const UI_PATH =
  /^(client|e2e|perf)\/|^server\/src\/tui\/|^server\/static\/|^server\/tests\/goldens\//;

/**
 * Route by the current phase and paths, never by prior verdicts.
 * @param {"plan" | "code"} phase
 * @param {string[]} files
 * @param {Array<{id?: unknown, description?: unknown}>} _previousFindings Retained for caller compatibility.
 * @returns {{lanes: Lane[], reason: string}}
 */
export function routeLanes(phase, files, _previousFindings) {
  if (phase === "plan")
    return {
      lanes: [...MANDATORY_LANES],
      reason: "Plans are reviewed by the mandatory lanes",
    };
  if (!files.some((file) => UI_PATH.test(file)))
    return {
      lanes: [...MANDATORY_LANES],
      reason: "No client, TUI, e2e, or asset paths changed",
    };
  return { lanes: [...REVIEW_LANES], reason: "UI paths changed" };
}
