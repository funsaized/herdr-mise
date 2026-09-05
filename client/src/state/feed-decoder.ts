import type { AgentStateEvent } from "../../../protocol/generated/agent-state-event";

// Validate the entire event before any store mutation. Bounds also protect the
// accessible DOM view from an unexpectedly large local source.
const states = new Set(["idle", "working", "blocked", "done", "ended"]);
const sources = new Set([
  "connected",
  "unavailableSocket",
  "timeout",
  "unsupportedProtocol",
  "incompatibleResponse",
]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 4096;
const natural = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const optionalBoolean = (value: unknown) =>
  value === undefined || typeof value === "boolean";
function agent(value: unknown): boolean {
  if (!object(value) || !object(value.session)) return false;
  return (
    keys(value, [
      "id",
      "name",
      "state",
      "stateKnown",
      "progress",
      "stateEnteredAt",
      "accentIndex",
      "model",
      "workspace",
      "session",
    ]) &&
    keys(value.session, ["runtimeMs", "tickets", "ticketsAvailable"]) &&
    optionalBoolean(value.stateKnown) &&
    optionalBoolean(value.session.ticketsAvailable) &&
    text(value.id) &&
    value.id.length > 0 &&
    text(value.name) &&
    value.name.length > 0 &&
    text(value.model) &&
    text(value.workspace) &&
    typeof value.state === "string" &&
    states.has(value.state) &&
    text(value.stateEnteredAt) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      value.stateEnteredAt,
    ) &&
    Number.isFinite(Date.parse(value.stateEnteredAt)) &&
    natural(value.accentIndex) &&
    value.accentIndex < 12 &&
    (value.progress === null ||
      (typeof value.progress === "number" &&
        Number.isFinite(value.progress) &&
        value.progress >= 0 &&
        value.progress <= 1)) &&
    natural(value.session.runtimeMs) &&
    natural(value.session.tickets)
  );
}
export function decodeFeedEvent(raw: string): AgentStateEvent | null {
  if (raw.length > 4 * 1024 * 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!object(value) || value.version !== 1) return null;
  if (value.type === "heartbeat")
    return keys(value, ["version", "type"])
      ? (value as unknown as AgentStateEvent)
      : null;
  if (value.mode !== "live" && value.mode !== "demo") return null;
  if (value.type === "snapshot") {
    if (
      !keys(value, [
        "version",
        "type",
        "mode",
        "sourceStatus",
        "sourceDiagnostic",
        "agents",
      ])
    )
      return null;
    if (
      typeof value.sourceStatus !== "string" ||
      !sources.has(value.sourceStatus) ||
      !Array.isArray(value.agents) ||
      value.agents.length > 4096 ||
      !value.agents.every(agent)
    )
      return null;
    const ids = value.agents.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) return null;
    if (value.sourceDiagnostic !== undefined) {
      const diagnostic = value.sourceDiagnostic;
      if (
        !object(diagnostic) ||
        !keys(diagnostic, [
          "observedProtocol",
          "supportedProtocols",
          "nextAction",
        ]) ||
        !natural(diagnostic.observedProtocol) ||
        !Array.isArray(diagnostic.supportedProtocols) ||
        diagnostic.supportedProtocols.length > 64 ||
        diagnostic.supportedProtocols.length === 0 ||
        new Set(diagnostic.supportedProtocols).size !==
          diagnostic.supportedProtocols.length ||
        !diagnostic.supportedProtocols.every(natural) ||
        !text(diagnostic.nextAction) ||
        !diagnostic.nextAction.length
      )
        return null;
    }
  } else if (value.type === "delta") {
    if (
      !keys(value, [
        "version",
        "type",
        "mode",
        "operation",
        value.operation === "upsert" ? "agent" : "agentId",
      ])
    )
      return null;
    if (
      value.operation === "upsert"
        ? !agent(value.agent)
        : value.operation !== "remove" ||
          !text(value.agentId) ||
          !value.agentId.length
    )
      return null;
  } else return null;
  return value as unknown as AgentStateEvent;
}
