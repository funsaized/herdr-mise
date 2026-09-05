// Generated-shape bindings for schema/agent-state-event.v1.schema.json.
export const PROTOCOL_VERSION = 1 as const;
export type AgentState = "idle" | "working" | "blocked" | "done" | "ended";
export type AppMode = "live" | "demo";
export type SourceStatus = "unavailableSocket" | "timeout" | "unsupportedProtocol" | "incompatibleResponse" | "connected";
export interface SourceDiagnostic { observedProtocol: number; supportedProtocols: number[]; nextAction: string }
export interface SessionStats { runtimeMs: number; tickets: number; ticketsAvailable?: boolean }
export interface AgentRecord {
  stateKnown?: boolean;
  id: string;
  name: string;
  state: AgentState;
  progress: number | null;
  stateEnteredAt: string;
  accentIndex: number;
  model: string;
  workspace: string;
  session: SessionStats;
}
export type AgentStateEvent =
  | { version: typeof PROTOCOL_VERSION; type: "snapshot"; mode: AppMode; sourceStatus: SourceStatus; sourceDiagnostic?: SourceDiagnostic; agents: AgentRecord[] }
  | { version: typeof PROTOCOL_VERSION; type: "delta"; mode: AppMode; operation: "upsert"; agent: AgentRecord }
  | { version: typeof PROTOCOL_VERSION; type: "delta"; mode: AppMode; operation: "remove"; agentId: string }
  | { version: typeof PROTOCOL_VERSION; type: "heartbeat" };
