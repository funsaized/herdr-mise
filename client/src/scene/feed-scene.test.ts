import { describe, expect, it } from "vitest";
import type { AgentStateEvent } from "../../../protocol/generated/agent-state-event";
import fixture from "../../../protocol/fixtures/snapshot.v1.json";
import { AgentStore } from "../state/store";
import { tokens } from "../theme/tokens";
import { assignedIdlePose, IdlePoseAssignments } from "./idle-poses";
import { sceneContinuousMotion, sceneDiscreteWakeDelay } from "./kitchen-scene";

describe("feed to scene boundary", () => {
  it("preserves feed accents and assigns only the new idle poses", () => {
    const store = new AgentStore();
    store.apply(fixture as AgentStateEvent);
    const agents = store.snapshot().agents,
      working = agents.get("agent-01")!,
      idle = agents.get("agent-02")!,
      assignments = new IdlePoseAssignments(() => 0);

    expect(
      assignedIdlePose(working.targetState, working.id, assignments),
    ).toBeNull();
    expect(tokens.accents[working.accentIndex]).toBe(tokens.accents[2]);
    expect(
      assignedIdlePose(idle.targetState, idle.id, assignments),
    ).not.toMatch(/prep|smoke/i);
    expect(tokens.accents[idle.accentIndex]).toBe(tokens.accents[7]);
    expect(sceneContinuousMotion(false, agents.values())).toBe(true);
    expect(sceneContinuousMotion(false, [idle])).toBe(false);
    expect(sceneContinuousMotion(true, agents.values())).toBe(false);
    expect(sceneContinuousMotion(false, [idle], { transitions: 1 })).toBe(true);
    expect(sceneDiscreteWakeDelay(false, [idle], true)).toBe(700);
    expect(sceneDiscreteWakeDelay(false, [idle], false)).toBeNull();
    expect(sceneDiscreteWakeDelay(true, [idle], true)).toBeNull();
    const blocked = { ...idle, targetState: "blocked" as const };
    expect(sceneDiscreteWakeDelay(false, [blocked], false)).toBe(250);
    expect(sceneDiscreteWakeDelay(true, [blocked], false)).toBe(1_000);
    expect(sceneDiscreteWakeDelay(false, [], false)).toBeNull();

    store.apply({
      version: 1,
      type: "delta",
      mode: fixture.mode,
      operation: "upsert",
      agent: { ...fixture.agents[0]!, state: "ended" },
    } as AgentStateEvent);
    expect(store.snapshot().board[0]?.accentIndex).toBe(2);
  });
});
