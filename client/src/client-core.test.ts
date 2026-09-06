import { describe, expect, it, vi } from "vitest";
import type {
  AgentRecord,
  AgentStateEvent,
} from "../../protocol/generated/agent-state-event";
import fixtureSnapshot from "../../protocol/fixtures/snapshot.v1.json";
import {
  blockedPlacements,
  compactPixelText,
  donePlateGeometry,
  doorGeometry,
  stationIdentityLabels,
  stationTicketGeometry,
  stationWorkspaceLabel,
  workspaceDisplayName,
} from "./scene/geometry";
import {
  BUSSER_SWEEP_MS,
  BOARD_HEADERS,
  BusserSweepTimeline,
  boardPaintStrings,
  busserSweepSample,
  sceneMotionPolicy,
  shouldDisposeRetainedStation,
  shouldReconcileBusserClear,
} from "./scene/kitchen-scene";
import {
  computeFreezerLayout,
  computeLayout,
  stationVisualMetrics,
} from "./scene/layout";
import { ParticlePool } from "./scene/particles";
import { TransitionEngine } from "./scene/transition";
import { BellController, SharedBellAudio } from "./sound/bell";
import { AgentStore, type Scheduler } from "./state/store";
import { AgentWebSocketClient, type SocketLike } from "./state/ws-client";
import {
  accentIndexForId,
  getTheme,
  registerTheme,
  resolveTheme,
} from "./theme/theme";
import { tokens } from "./theme/tokens";

function luminance(hex: string) {
  const values = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}
function contrastRatio(one: string, two: string) {
  const a = luminance(one),
    b = luminance(two);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

class FakeClock implements Scheduler {
  time = 0;
  private next = 1;
  private jobs = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.jobs.set(id, { at: this.time + ms, fn });
    return id;
  }
  clearTimeout(id: unknown) {
    this.jobs.delete(id as number);
  }
  advance(ms: number) {
    this.time += ms;
    for (;;) {
      const job = [...this.jobs]
        .sort((a, b) => a[1].at - b[1].at)
        .find(([, value]) => value.at <= this.time);
      if (!job) return;
      this.jobs.delete(job[0]);
      job[1].fn();
    }
  }
}
const agent = (
  state: AgentRecord["state"] = "working",
  id = "a",
  progress: number | null = 0.4,
): AgentRecord => ({
  id,
  name: `agent-${id}`,
  state,
  progress,
  stateEnteredAt: "2026-07-31T00:00:00Z",
  accentIndex: id.charCodeAt(0) % 12,
  model: "codex",
  workspace: "/work",
  session: { runtimeMs: 1_000, tickets: 2 },
});
const snapshot = (...agents: AgentRecord[]): AgentStateEvent => ({
  version: 1,
  type: "snapshot",
  mode: "live",
  sourceStatus: "connected",
  agents,
});
const upsert = (record: AgentRecord): AgentStateEvent => ({
  version: 1,
  type: "delta",
  mode: "live",
  operation: "upsert",
  agent: record,
});

describe("agent store machines", () => {
  it("keeps fixture feed identity and layout unchanged when atmosphere is off", () => {
    const store = new AgentStore();
    store.apply(fixtureSnapshot as AgentStateEvent);
    const projection = () => {
      const agents = [...store.snapshot().agents.values()],
        layout = computeLayout(
          1200,
          740,
          agents.map(({ id }) => id),
        );
      return {
        feed: agents.map(({ id, name, workspace, targetState }) => ({
          id,
          name,
          workspace,
          targetState,
        })),
        labels: agents.map((agent) =>
          stationIdentityLabels(agent, agent.targetState),
        ),
        stations: layout.stations,
      };
    };
    const atmosphereOn = projection();
    store.setSettings({ atmosphere: false });

    expect(projection()).toEqual(atmosphereOn);
  });
  it("paints fixture-backed 86 board columns with truthful runtime", () => {
    const store = new AgentStore();
    store.apply(fixtureSnapshot as AgentStateEvent);
    const ended = { ...fixtureSnapshot.agents[0]!, state: "ended" as const };
    store.apply(upsert(ended));

    expect(BOARD_HEADERS).toEqual(["COOK", "MISE TIME"]);
    expect(boardPaintStrings(store.snapshot().board[0]!)).toEqual([
      "REFACTOR-AGENT",
      "15:01",
    ]);
    expect(boardPaintStrings(store.snapshot().board[0]!)[1]).not.toContain(
      "15M",
    );
    expect(
      boardPaintStrings({ name: "zero", runtimeMs: 0, tickets: 0 }),
    ).toEqual(["ZERO", "—"]);
  });
  it("collapses rapid truth changes and converges within one second", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock);
    store.apply(snapshot(agent("working")));
    clock.advance(100);
    store.apply(upsert(agent("blocked")));
    clock.advance(200);
    store.apply(upsert(agent("working")));
    expect(store.snapshot().agents.get("a")?.renderedState).toBe("working");
    clock.advance(800);
    store.reconcileRendered();
    expect(store.snapshot().agents.get("a")?.renderedState).toBe("working");
  });
  it("settles rendered truth by the shortest visual transition to prevent transition restarts", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock);
    store.apply(snapshot(agent("working")));
    store.apply(upsert(agent("blocked")));
    clock.advance(519);
    store.reconcileRendered();
    expect(store.snapshot().agents.get("a")?.renderedState).toBe("working");
    clock.advance(1);
    store.reconcileRendered();
    expect(store.snapshot().agents.get("a")?.renderedState).toBe("blocked");
  });
  it("emits busser and clear at the configured done timeout", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock, { doneTimeoutMs: 50 }),
      events: string[] = [];
    store.onEvent((event) => events.push(event.type));
    store.apply(snapshot(agent("done")));
    clock.advance(49);
    expect(store.snapshot().agents.size).toBe(1);
    clock.advance(1);
    expect(store.snapshot().agents.size).toBe(0);
    expect(events.slice(-2)).toEqual(["busser", "clear"]);
  });
  it("does not extend a done deadline for progress deltas", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock, { doneTimeoutMs: 50 });
    store.apply(snapshot(agent("done")));
    clock.advance(40);
    store.apply(upsert(agent("done", "a", 0.9)));
    clock.advance(10);
    expect(store.snapshot().agents.size).toBe(0);
  });
  it("does not notify coarse subscribers for progress-only deltas", () => {
    const store = new AgentStore(),
      listener = vi.fn();
    store.apply(snapshot(agent()));
    store.subscribeCoarse(listener);
    store.apply(upsert(agent("working", "a", 0.9)));
    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshot().agents.get("a")?.progress).toBe(0.9);
  });
  it("records a same-state re-entry observed after reconnect", () => {
    const store = new AgentStore(),
      first = agent("working"),
      reentered = { ...first, stateEnteredAt: "2026-07-31T00:01:00Z" };
    store.apply(snapshot(first));
    store.setDisconnected();
    store.apply(snapshot(reentered));
    expect(store.snapshot().agents.get("a")?.history).toEqual([
      { state: "working", startedAt: Date.parse(first.stateEnteredAt) },
      { state: "working", startedAt: Date.parse(reentered.stateEnteredAt) },
    ]);
  });
  it("atomically replaces demo agents and source status from a live snapshot", () => {
    const store = new AgentStore();
    store.apply({
      version: 1,
      type: "snapshot",
      mode: "demo",
      sourceStatus: "unavailableSocket",
      agents: [agent("blocked", "demo-cook")],
    });
    store.apply(snapshot(agent("working", "live-agent")));
    expect(store.snapshot()).toMatchObject({
      mode: "live",
      feedMode: "live",
      sourceStatus: "connected",
    });
    expect([...store.snapshot().agents.keys()]).toEqual(["live-agent"]);
  });
  it("keeps demo mode for an empty unsupported snapshot", () => {
    const store = new AgentStore();
    store.apply({
      version: 1,
      type: "snapshot",
      mode: "demo",
      sourceStatus: "unsupportedProtocol",
      sourceDiagnostic: {
        observedProtocol: 23,
        supportedProtocols: [19, 20],
        nextAction: "upgrade Herdr, then retry",
      },
      agents: [],
    });
    expect(store.snapshot()).toMatchObject({
      mode: "demo",
      sourceStatus: "unsupportedProtocol",
    });
    store.apply(snapshot());
    expect(store.snapshot().mode).toBe("empty");
  });
  it("keeps ended history FIFO-capped at 50 and releases agents", () => {
    const store = new AgentStore();
    for (let i = 0; i < 55; i++)
      store.apply(upsert(agent("ended", String.fromCharCode(65 + i))));
    expect(store.snapshot().agents.size).toBe(0);
    expect(store.snapshot().board).toHaveLength(50);
    expect(store.snapshot().board[0]?.id).toBe("F");
  });
  it.each(["blocked", "working", "done"] as const)(
    "records a truthful %s final state",
    (finalState) => {
      const clock = new FakeClock(),
        store = new AgentStore(clock);
      store.apply(snapshot(agent(finalState)));
      clock.advance(10);
      store.apply(upsert(agent("ended")));
      expect(store.snapshot().board).toHaveLength(1);
      expect(store.snapshot().board[0]?.finalState).toBe(finalState);
    },
  );
  it("deduplicates repeated ended snapshots without replacing the truthful final state or FIFO position", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock);
    store.apply(snapshot(agent("blocked", "a"), agent("working", "b")));
    store.apply(upsert(agent("ended", "a")));
    const endedAt = store.snapshot().board[0]!.endedAt;
    clock.advance(1_000);
    store.apply(snapshot(agent("working", "b"), agent("ended", "a")));
    expect(store.snapshot().board).toHaveLength(1);
    expect(store.snapshot().board[0]).toMatchObject({
      id: "a",
      finalState: "blocked",
      endedAt,
    });
  });
  it("keeps each death of a reused pane on the 86 board", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock);
    store.apply(snapshot(agent("working", "p-1")));
    store.apply(upsert(agent("ended", "p-1")));
    clock.advance(1_000);
    store.apply(upsert(agent("idle", "p-1")));
    store.apply(upsert(agent("ended", "p-1")));
    const board = store.snapshot().board;
    expect(board).toHaveLength(2);
    expect(board[0]?.id).toBe("p-1");
    expect(board[1]?.id.startsWith("p-1:")).toBe(true);
    expect(board.map((entry) => entry.finalState)).toEqual(["working", "idle"]);
  });
});

describe("layout, transitions and resources", () => {
  it("places only the newest fitting freezer spirits in deterministic safe slots", () => {
    const ids = Array.from({ length: 20 }, (_, index) => `ended-${index}`),
      first = computeFreezerLayout(420, 480, ids),
      second = computeFreezerLayout(420, 480, ids);
    expect(first).toEqual(second);
    expect(first.spirits.length).toBeGreaterThan(0);
    expect(first.spirits.map((slot) => slot.id)).toEqual(
      ids.slice(-first.spirits.length),
    );
    for (const [index, slot] of first.spirits.entries()) {
      expect(slot.x).toBeGreaterThanOrEqual(first.floor.x);
      expect(slot.y).toBeGreaterThanOrEqual(first.floor.y);
      expect(slot.x + slot.width).toBeLessThanOrEqual(
        first.floor.x + first.floor.width,
      );
      expect(slot.y + slot.height).toBeLessThanOrEqual(
        first.floor.y + first.floor.height,
      );
      for (const keepout of [
        first.door,
        ...first.racks,
        ...first.frost,
        first.emptyPill,
      ])
        expect(
          slot.x < keepout.x + keepout.width &&
            keepout.x < slot.x + slot.width &&
            slot.y < keepout.y + keepout.height &&
            keepout.y < slot.y + slot.height,
        ).toBe(false);
      for (const other of first.spirits.slice(index + 1))
        expect(
          slot.x < other.x + other.width &&
            other.x < slot.x + slot.width &&
            slot.y < other.y + other.height &&
            other.y < slot.y + slot.height,
        ).toBe(false);
    }
  });
  it("disables every decorative scene motion channel only while reduced motion is active", () => {
    expect(sceneMotionPolicy(true)).toEqual({
      idle: false,
      steam: false,
      cook: false,
      escalation: false,
      travel: false,
      busser: false,
      transitions: false,
    });
    expect(sceneMotionPolicy(false)).toEqual({
      idle: true,
      steam: true,
      cook: true,
      escalation: true,
      travel: true,
      busser: true,
      transitions: true,
    });
  });
  it.each([
    [1, 1, 1, false],
    [6, 3, 2, false],
    [12, 6, 2, true],
  ] as const)("lays out %i agents", (count, columns, rows, banquet) => {
    const result = computeLayout(
      1200,
      740,
      Array.from({ length: count }, (_, i) => String(i)),
    );
    expect([result.columns, result.rows, result.banquet]).toEqual([
      columns,
      rows,
      banquet,
    ]);
    expect(result.stations).toHaveLength(count);
    for (const rect of result.stations) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1200);
    }
  });
  it.each([
    [320, 640],
    [390, 844],
    [720, 720],
    [1280, 720],
    [1440, 900],
  ])("keeps 1/6/12-agent layouts bounded at %ix%i", (width, height) => {
    for (const count of [1, 6, 12]) {
      const layout = computeLayout(
        width,
        height,
        Array.from({ length: count }, (_, index) => String(index)),
      );
      for (const station of layout.stations) {
        expect(station.x).toBeGreaterThanOrEqual(0);
        expect(station.y).toBeGreaterThanOrEqual(0);
        expect(station.x + station.width).toBeLessThanOrEqual(width);
        expect(station.y + station.height).toBeLessThanOrEqual(height);
      }
    }
  });
  it("applies configured gutters and sparse composition dimensions", () => {
    const dense = computeLayout(
        390,
        844,
        Array.from({ length: 6 }, (_, index) => String(index)),
      ),
      sparse = computeLayout(1440, 900, ["solo"]),
      firstGap =
        dense.stations[1]!.x -
        (dense.stations[0]!.x + dense.stations[0]!.width);
    expect(firstGap).toBe(tokens.scene.layout.stationGutter * dense.unit);
    expect(firstGap).toBeGreaterThanOrEqual(6);
    expect(sparse.stations[0]!.scale).toBe(tokens.scene.layout.sparseScale);
    expect(sparse.stations[0]!.width).toBeGreaterThanOrEqual(350);
    expect(sparse.pass.width).toBeLessThanOrEqual(450);
    expect(sparse.pass.width).toBe(
      tokens.scene.layout.sparsePassWidth * sparse.unit,
    );
  });
  it.each([1, 2, 6, 12])(
    "keeps %i-agent compositions dense, bounded, and on-screen",
    (count) => {
      const layout = computeLayout(
        1200,
        740,
        Array.from({ length: count }, (_, i) => String(i)),
      );
      expect(layout.wall.height).toBeLessThanOrEqual(56 * layout.unit);
      expect(layout.pass.width).toBeLessThanOrEqual(132 * layout.unit);
      for (const station of layout.stations) {
        expect(station.width / layout.unit).toBeGreaterThanOrEqual(
          layout.banquet ? 28 : 40,
        );
        expect(station.y).toBeGreaterThan(layout.pass.y);
        expect(station.y + station.height).toBeLessThanOrEqual(740);
      }
    },
  );
  it.each([1, 2, 6, 12])(
    "gives %i agents useful pixel weight and balanced occupancy at 1280x633",
    (count) => {
      const layout = computeLayout(
        1280,
        633,
        Array.from({ length: count }, (_, i) => String(i)),
      );
      expect(layout.unit).toBe(4);
      const metrics = layout.stations.map((station) =>
        stationVisualMetrics(layout, station),
      );
      for (const metric of metrics) {
        expect(metric.cookHeight).toBeGreaterThanOrEqual(67);
        expect(metric.counterHeight).toBeGreaterThanOrEqual(32);
        expect(metric.labelFontSize).toBeGreaterThanOrEqual(10);
      }
      expect(
        Math.max(...metrics.map((metric) => metric.stationBottom)),
      ).toBeGreaterThanOrEqual(count <= 2 ? 500 : 600);
      expect(
        Math.max(...metrics.map((metric) => metric.stationBottom)),
      ).toBeLessThanOrEqual(633);
    },
  );
  it("caps and interrupts transitions at 800ms", () => {
    const engine = new TransitionEngine();
    expect(
      engine.begin("a", "working", "blocked", 0).durationMs,
    ).toBeLessThanOrEqual(800);
    engine.target("a", "blocked", "working", 300);
    expect(engine.sample("a", 1100)?.progress).toBe(1);
    expect(engine.activeCount()).toBe(0);
  });
  it.each([
    [1440, 900, 1],
    [1440, 900, 6],
    [1440, 900, 12],
    [390, 844, 1],
    [390, 844, 6],
    [390, 844, 12],
    [320, 640, 1],
    [320, 640, 6],
    [320, 640, 12],
  ])(
    "allocates the maximal blocked prefix at %ix%i for %i cooks",
    (width, height, count) => {
      const ids = Array.from(
          { length: count },
          (_, index) => `agent-${String(index + 1).padStart(2, "0")}`,
        ),
        layout = computeLayout(width, height, ids),
        placements = blockedPlacements(layout, [...ids].reverse()),
        ordered = layout.stations.map((station) => placements.get(station.id)!);
      expect(placements.size).toBe(count);
      expect(ordered.map((placement) => placement.queueOrdinal)).toEqual(
        ids.map((_, index) => index + 1),
      );
      expect(ordered.map((placement) => placement.kind).join(",")).toMatch(
        /^pass(?:,pass)*(?:,station)*$/,
      );

      const pass = ordered.filter((placement) => placement.kind === "pass"),
        intersects = (
          a: (typeof ordered)[number]["cookBounds"],
          b: (typeof ordered)[number]["cookBounds"],
        ) =>
          a.x < b.x + b.width &&
          a.x + a.width > b.x &&
          a.y < b.y + b.height &&
          a.y + a.height > b.y;
      ordered.forEach((placement, index) => {
        for (const bound of [
          placement.cookBounds,
          placement.ticket,
          placement.timer,
        ]) {
          expect(intersects(bound, ordered[0]!.bell)).toBe(false);
          for (const other of ordered.slice(index + 1))
            for (const otherBound of [
              other.cookBounds,
              other.ticket,
              other.timer,
            ])
              expect(intersects(bound, otherBound)).toBe(false);
        }
      });
      for (const placement of ordered.filter((item) => item.kind === "station"))
        for (const bound of [
          placement.cookBounds,
          placement.ticket,
          placement.timer,
        ]) {
          expect(bound.x).toBeGreaterThanOrEqual(placement.station.x - 0.001);
          expect(bound.y).toBeGreaterThanOrEqual(placement.station.y - 0.001);
          expect(bound.x + bound.width).toBeLessThanOrEqual(
            placement.station.x + placement.station.width + 0.001,
          );
          expect(bound.y + bound.height).toBeLessThanOrEqual(
            placement.station.y + placement.station.height + 0.001,
          );
        }
      const firstOverflow = ordered.findIndex(
        (placement) => placement.kind === "station",
      );
      if (firstOverflow >= 0)
        expect(
          blockedPlacements(layout, ids.slice(0, firstOverflow + 1)).get(
            ids[firstOverflow]!,
          )?.kind,
        ).toBe("station");
      expect(stationTicketGeometry("blocked", layout.unit)?.blocked).toBe(true);

      if (pass.length) {
        const retained = pass[0]!,
          next = blockedPlacements(layout, ids.slice(1), [retained]);
        for (const placement of next.values())
          if (placement.kind === "pass")
            for (const bound of [
              placement.cookBounds,
              placement.ticket,
              placement.timer,
            ])
              for (const occupied of [
                retained.cookBounds,
                retained.ticket,
                retained.timer,
              ])
                expect(intersects(bound, occupied)).toBe(false);
      }
    },
  );
  it.each([
    [1200, 740],
    [960, 540],
  ])(
    "grounds the %ix%i door frame and keeps its contents contained",
    (width, height) => {
      const layout = computeLayout(width, height, ["a", "b"]);
      for (const ajar of [false, true]) {
        const door = doorGeometry(layout, ajar);
        expect(door.frame.y + door.frame.height).toBe(layout.wall.height);
        expect(door.innerPanel.x).toBeGreaterThanOrEqual(door.frame.x);
        expect(door.innerPanel.y).toBeGreaterThan(door.frame.y);
        expect(door.innerPanel.x + door.innerPanel.width).toBeLessThanOrEqual(
          door.frame.x + door.frame.width,
        );
        expect(
          door.innerPanel.y + door.innerPanel.height + 2 * layout.unit,
        ).toBeLessThanOrEqual(door.frame.y + door.frame.height);
        expect(door.knob.x - door.knob.radius).toBeGreaterThanOrEqual(
          door.innerPanel.x,
        );
        expect(door.knob.x + door.knob.radius).toBeLessThanOrEqual(
          door.innerPanel.x + door.innerPanel.width,
        );
        expect(door.knob.y - door.knob.radius).toBeGreaterThanOrEqual(
          door.innerPanel.y,
        );
        expect(door.knob.y + door.knob.radius).toBeLessThanOrEqual(
          door.innerPanel.y + door.innerPanel.height,
        );
      }
    },
  );
  it.each([
    ["/work/customer-api", "customer-api"],
    ["/work/customer-api/", "customer-api"],
    ["C:\\work\\customer-api", "customer-api"],
    ["customer-api", "customer-api"],
    ["", "Unavailable"],
    ["/", "Unavailable"],
    ["C:\\", "Unavailable"],
  ])("derives workspace label %s as %s", (workspace, expected) => {
    expect(workspaceDisplayName(workspace)).toBe(expected);
  });
  it("invalidates a station label when only its workspace changes", () => {
    const before = stationWorkspaceLabel("/work/customer-api"),
      after = stationWorkspaceLabel("/work/payments");
    expect(before).toEqual({
      text: "CUSTOMER-API",
      signature: "/work/customer-api",
    });
    expect(after).toEqual({ text: "PAYMENTS", signature: "/work/payments" });
    expect(after.signature).not.toBe(before.signature);
  });
  it("makes agent, workspace, and state legible on station surfaces", () => {
    expect(
      stationIdentityLabels(
        {
          name: "Claude",
          workspace: "/work/payments",
        },
        "blocked",
      ),
    ).toEqual({
      name: "CLAUDE · PAYMENTS",
      status: "AT THE PASS",
      signature: "Claude:/work/payments",
    });
  });
  it("keeps every banquet status suffix intact within the 18-character bound", () => {
    const base = {
        name: "Claude",
        workspace: "/service/very-long-workspace",
      },
      now = Date.now(),
      cases = [
        ["blocked", "AT THE PASS"],
        ["working", "FIRE"],
        ["done", "PLATED"],
        ["idle", "PREP"],
        ["ended", "86'D"],
      ] as const;
    for (const [state, suffix] of cases) {
      const label = stationIdentityLabels(base, state, now, 18);
      expect(label.status.length).toBeLessThanOrEqual(18);
      expect(label.status).toContain(suffix);
    }
    const answered = stationIdentityLabels(
      { ...base, answerReceivedUntil: now + 2_000 },
      "working",
      now,
      18,
    );
    expect(answered.status).toBe("ANSWER RECEIVED");
  });
  it("caps banquet identity labels so adjacent 12-agent cells retain separation", () => {
    const ids = Array.from(
        { length: 12 },
        (_, index) => `visual-agent-${index + 1}`,
      ),
      layout = computeLayout(1280, 720, ids),
      labels = ids.map((id, index) =>
        stationIdentityLabels(
          {
            name: `Agent-${index + 1}`,
            workspace: `/service/very-long-workspace-${index + 1}`,
          },
          "working",
          Date.now(),
          18,
        ),
      );
    expect(layout.banquet).toBe(true);
    expect(
      labels.every(
        (label) => label.name.length <= 18 && label.status.length <= 18,
      ),
    ).toBe(true);
    const estimatedWidth = 18 * 2.1 * layout.unit * 0.6;
    expect(estimatedWidth).toBeLessThan(layout.stations[0]!.width);
    expect(labels[1]!.name).toContain("...");
    expect(labels[2]!.name).toContain("...");
    expect(
      stationIdentityLabels(
        { name: "density-01", workspace: "/service/density" },
        "blocked",
        Date.now(),
        6,
      ).name,
    ).toBe("D...01");
  });
  it("compacts arbitrary station text deterministically while preserving short demo labels", () => {
    expect(compactPixelText("CLAUDE · PAYMENTS")).toBe("CLAUDE · PAYMENTS");
    expect(
      compactPixelText(
        "AN-ARBITRARILY-LONG-LIVE-AGENT · AN-EVEN-LONGER-WORKSPACE",
      ),
    ).toBe("AN-ARBITRARILY-LONG-LIVE-AG...");
    expect(compactPixelText("  MODEL  ", 4)).toBe("M...");
    expect(compactPixelText("long", 2)).toBe("..");
  });
  it("places a finished plate on the counter with face-safe emphasis rays", () => {
    const plate = donePlateGeometry(48, 1, 19);
    expect(plate.center).toEqual({ x: 32, y: 18 });
    expect(plate.radius).toEqual({ x: 7, y: 2 });
    expect(plate.rays).toHaveLength(5);
    expect(plate.rays.every((ray) => ray.y >= 10)).toBe(true);
    expect(plate.rays.every((ray) => ray.y + ray.height <= 19)).toBe(true);
  });
  it("reuses a fixed particle pool", () => {
    const pool = new ParticlePool(2),
      first = pool.acquire(1, 2);
    pool.update(1000);
    const second = pool.acquire(3, 4);
    expect(second).toBe(first);
    expect(pool.particles).toHaveLength(2);
    expect(pool.reused).toBe(2);
  });
  it("sweeps deterministically across the affected station before expiring", () => {
    const rect = { x: 100, y: 200, width: 200, height: 100 },
      start = 1_000;
    expect(busserSweepSample(rect, start, start)).toEqual({
      progress: 0,
      x: 118,
      y: 243,
      alpha: 1,
    });
    expect(busserSweepSample(rect, start, start + BUSSER_SWEEP_MS / 2)).toEqual(
      { progress: 0.5, x: 200, y: 243, alpha: 1 },
    );
    expect(busserSweepSample(rect, start, start + BUSSER_SWEEP_MS)).toBeNull();
  });
  it("self-cleans completed and explicitly cleared busser lifecycle state", () => {
    const timeline = new BusserSweepTimeline(),
      rect = { x: 0, y: 0, width: 100, height: 50 };
    timeline.start("a", rect, 10);
    expect(timeline.has("a")).toBe(true);
    expect(timeline.sample("a", 10 + BUSSER_SWEEP_MS)).toBeNull();
    expect(timeline.size).toBe(0);
    timeline.start("b", rect, 20);
    timeline.clear();
    expect(timeline.ids()).toEqual([]);
  });
  it("does not dispose a retained station when the same agent ID is live again at sweep expiry", () => {
    expect(shouldDisposeRetainedStation(new Set(["a"]), "a")).toBe(false);
    expect(shouldDisposeRetainedStation(new Set(), "a")).toBe(true);
  });
  it("reconciles clear events only for an agent with a busser-owned active sweep", () => {
    const activeSweeps = new Set(["done-agent"]);
    expect(shouldReconcileBusserClear(activeSweeps, "done-agent")).toBe(true);
    expect(
      shouldReconcileBusserClear(activeSweeps, "snapshot-removed-agent"),
    ).toBe(false);
  });
});

describe("theme boundary and bell", () => {
  it("keeps every station name and state label at accessible contrast on the floor", () => {
    for (const themeIndex of [0, 1] as const) {
      const floor = tokens.scene.floor[themeIndex];
      expect(
        contrastRatio(tokens.scene.stationName[themeIndex], floor),
        `name:${themeIndex}`,
      ).toBeGreaterThanOrEqual(4.5);
      for (const state of [
        "idle",
        "working",
        "blocked",
        "done",
        "ended",
      ] as const)
        expect(
          contrastRatio(tokens.scene.stationState[state][themeIndex], floor),
          `${state}:${themeIndex}`,
        ).toBeGreaterThanOrEqual(4.5);
    }
    expect(tokens.scene.stationName[0]).toBe(tokens.scene.ink);
  });
  it("resolves system lighting and accepts renderer-independent registrations", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    const base = getTheme();
    registerTheme({
      ...base,
      id: "test",
      spritesheet: "test.png",
      layout: { ...base.layout, stationWidth: 99 },
    });
    expect(getTheme("test").layout.stationWidth).toBe(99);
  });
  it("assigns stable bounded accents from agent identity", () => {
    expect(accentIndexForId("agent-a")).toBe(accentIndexForId("agent-a"));
    expect(accentIndexForId("agent-a")).toBeGreaterThanOrEqual(0);
    expect(accentIndexForId("agent-a")).toBeLessThan(12);
  });
  it("logs exactly enter and the two escalation threshold dings", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock, {
        sound: true,
        escalationFastMs: 100,
        escalationVignetteMs: 500,
      }),
      ding = vi.fn(),
      bell = new BellController(store, ding, clock.now);
    store.apply(snapshot(agent("working")));
    store.apply(upsert(agent("blocked")));
    clock.advance(99);
    bell.tick();
    clock.advance(1);
    bell.tick();
    clock.advance(400);
    bell.tick();
    expect(bell.log.map((item) => item.reason)).toEqual([
      "enter",
      "fast",
      "vignette",
    ]);
    expect(ding).toHaveBeenCalledTimes(3);
    bell.destroy();
  });
  it("stays silent when sound is disabled", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock),
      ding = vi.fn(),
      bell = new BellController(store, ding, clock.now);
    store.apply(snapshot(agent("blocked")));
    clock.advance(600_000);
    bell.tick();
    expect(ding).not.toHaveBeenCalled();
    expect(bell.log).toEqual([]);
  });
  it("lazily creates, resumes, and reuses one audio context", async () => {
    const oscillator = {
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      },
      gain = {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(() => gain),
      },
      context = {
        state: "suspended",
        currentTime: 1,
        destination: {},
        resume: vi.fn(async () => {
          context.state = "running";
        }),
        createOscillator: vi.fn(() => oscillator),
        createGain: vi.fn(() => gain),
      },
      create = vi.fn(() => context as unknown as AudioContext),
      audio = new SharedBellAudio(create);
    audio.ding();
    expect(create).not.toHaveBeenCalled();
    await audio.resume();
    await audio.resume();
    expect(create).toHaveBeenCalledOnce();
    expect(context.resume).toHaveBeenCalledOnce();
    audio.ding();
    expect(context.createOscillator).toHaveBeenCalledOnce();
  });
});

describe("websocket loss and resync", () => {
  it("ignores deltas until each connection establishes an authoritative snapshot", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock),
      socket = new FakeSocket(),
      client = new AgentWebSocketClient(
        "ws://test",
        store,
        () => socket,
        clock,
      );
    client.start();
    socket.open();
    socket.message(upsert(agent("blocked")));
    expect(store.snapshot().agents.size).toBe(0);
    socket.message(snapshot(agent("working")));
    socket.message(upsert(agent("blocked")));
    expect(store.snapshot().agents.get("a")?.targetState).toBe("blocked");
    client.stop();
  });
  it("surfaces a socket whose opening handshake never completes within three seconds", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock),
      sockets: FakeSocket[] = [];
    const client = new AgentWebSocketClient(
      "ws://test",
      store,
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      clock,
    );
    client.start();
    expect(store.snapshot().mode).toBe("connecting");
    clock.advance(2_899);
    expect(store.snapshot().mode).toBe("connecting");
    clock.advance(1);
    expect(store.snapshot().mode).toBe("disconnected");
    clock.advance(1_000);
    expect(sockets).toHaveLength(2);
    client.stop();
  });
  it("disconnects within three seconds, reconnects, and applies a fresh snapshot", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock),
      sockets: FakeSocket[] = [];
    const client = new AgentWebSocketClient(
      "ws://test",
      store,
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      clock,
    );
    client.start();
    sockets[0]!.open();
    sockets[0]!.message(snapshot(agent()));
    expect(store.snapshot().mode).toBe("live");
    clock.advance(2_900);
    expect(store.snapshot().mode).toBe("disconnected");
    sockets[0]!.closeEvent();
    clock.advance(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.message(snapshot(agent("idle", "b")));
    expect([...store.snapshot().agents.keys()]).toEqual(["b"]);
    expect(store.snapshot().mode).toBe("live");
    client.stop();
  });
  it("treats heartbeats as liveness without mutating agent state", () => {
    const clock = new FakeClock(),
      store = new AgentStore(clock),
      socket = new FakeSocket(),
      client = new AgentWebSocketClient(
        "ws://test",
        store,
        () => socket,
        clock,
      );
    client.start();
    socket.open();
    socket.message(snapshot(agent()));
    const lastUpdate = store.snapshot().lastUpdateAt;
    for (let i = 0; i < 3; i++) {
      clock.advance(2_000);
      socket.message({ version: 1, type: "heartbeat" });
    }
    expect(store.snapshot().mode).toBe("live");
    expect(store.snapshot().lastUpdateAt).toBe(lastUpdate);
    expect(store.snapshot().agents.get("a")?.revision).toBe(1);
    client.stop();
  });
});

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(event: AgentStateEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  closeEvent() {
    this.onclose?.();
  }
}
