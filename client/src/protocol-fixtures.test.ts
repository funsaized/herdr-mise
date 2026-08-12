import { describe, expect, it } from "vitest";
import snapshot from "../../protocol/fixtures/snapshot.v1.json";
import unsupported from "../../protocol/fixtures/snapshot-demo-unsupported.v1.json";
import upsert from "../../protocol/fixtures/delta-upsert.v1.json";
import remove from "../../protocol/fixtures/delta-remove.v1.json";
import heartbeat from "../../protocol/fixtures/heartbeat.v1.json";
import {
  PROTOCOL_VERSION,
  type AgentStateEvent,
} from "../../protocol/generated/agent-state-event";

describe("shared protocol fixtures", () => {
  it.each([snapshot, unsupported, upsert, remove, heartbeat])(
    "round trips versioned fixture",
    (fixture) => {
      const event = fixture as AgentStateEvent;
      expect(event.version).toBe(PROTOCOL_VERSION);
      expect(JSON.parse(JSON.stringify(event))).toEqual(fixture);
    },
  );
});
