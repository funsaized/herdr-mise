import { describe, expect, it } from "vitest";
import type { Graphics } from "pixi.js";
import { assignedIdlePose, drawIdlePose, idleAnimationFrame, idlePoseIsAnimated, IdlePoseAssignments, sampleIdlePose, SMOKE_LIFT_CYCLE_MS, smokeLiftUnits, type IdlePose } from "./idle-poses";

interface RecordedRect { x: number; y: number; width: number; height: number; fill?: unknown }

class RecordingGraphics {
  circles: Array<{ x: number; y: number; radius: number }> = [];
  rects: RecordedRect[] = [];
  ellipses: Array<{ x: number; y: number; radiusX: number; radiusY: number }> = [];
  paths: Array<Array<{ x: number; y: number }>> = [];
  private path: Array<{ x: number; y: number }> = [];
  private pendingRect?: RecordedRect;

  rect(x: number, y: number, width: number, height: number) { const rect = { x, y, width, height }; this.rects.push(rect); this.pendingRect = rect; return this; }
  ellipse(x: number, y: number, radiusX: number, radiusY: number) { this.ellipses.push({ x, y, radiusX, radiusY }); this.pendingRect = undefined; return this; }
  fill(color?: unknown) { if (this.pendingRect) this.pendingRect.fill = color; this.pendingRect = undefined; return this; }
  circle(x: number, y: number, radius: number) { this.circles.push({ x, y, radius }); return this; }
  moveTo(x: number, y: number) { this.path = [{ x, y }]; this.paths.push(this.path); return this; }
  lineTo(x: number, y: number) { this.path.push({ x, y }); return this; }
  stroke() { return this; }
}

const colors = {
  coat: "coat", skin: "skin", ink: "ink", accent: "accent", wood: "wood",
  boot: ["boot-0", "boot-1"], chair: ["chair-0", "chair-1"],
  cigarette: ["cigarette-0", "cigarette-1"], smoke: ["smoke-0", "smoke-1"], green: "green",
} as const;

const draw = (pose: IdlePose, stationWidth: number, elapsedMs = 0, u = 4) => {
  const graphics = new RecordingGraphics();
  drawIdlePose(graphics as unknown as Graphics, pose, sampleIdlePose(pose, elapsedMs), stationWidth * u / 2, 19 * u, u, colors);
  return graphics;
};

const horizontalBounds = (graphics: RecordingGraphics) => [
  ...graphics.rects.flatMap(rect => [rect.x, rect.x + rect.width]),
  ...graphics.circles.flatMap(circle => [circle.x - circle.radius, circle.x + circle.radius]),
  ...graphics.ellipses.flatMap(ellipse => [ellipse.x - ellipse.radiusX, ellipse.x + ellipse.radiusX]),
  ...graphics.paths.flatMap(path => path.map(point => point.x)),
];

describe("idle pose assignment", () => {
  it("cycles SMOKE, RECLINE, SLEEP, PREP and keeps an agent stable for the session", () => {
    const assignments = new IdlePoseAssignments(() => 0);
    const ids = ["a", "b", "c", "d", "e"];

    expect(ids.map(id => assignments.for(id))).toEqual(["smoke", "recline", "sleep", "prep", "smoke"]);
    expect(assignments.for("c")).toBe("sleep");
    expect(new Set(ids.slice(0, 4).map(id => assignments.for(id)))).toEqual(new Set(["smoke", "recline", "sleep", "prep"]));
  });

  it("rotates the balanced pose sequence from a session-random starting point", () => {
    const assignments = new IdlePoseAssignments(() => .5);
    expect(["a", "b", "c", "d", "e"].map(id => assignments.for(id))).toEqual(["sleep", "prep", "smoke", "recline", "sleep"]);
  });

  it("assigns decoration only to operationally idle agents", () => {
    const assignments = new IdlePoseAssignments(() => 0);
    expect(assignedIdlePose("idle", "a", assignments)).toBe("smoke");
    for (const state of ["working", "blocked", "done", "ended"] as const) {
      expect(assignedIdlePose(state, state, assignments)).toBeNull();
    }
  });
});

describe("idle pose rendering geometry", () => {
  it("emits smoke and sleep particles above the cook and clear of the label band", () => {
    const u = 4;
    const smoke = draw("smoke", 40, 6 * 140, u);
    expect(smoke.circles).toHaveLength(2);
    expect(smoke.circles.every(mark => mark.y + mark.radius < 19 * u)).toBe(true);

    const sleep = draw("sleep", 40, 3 * 140, u);
    expect(sleep.paths).toHaveLength(2);
    expect(sleep.paths.flat().every(point => point.y < 30 * u)).toBe(true);
  });

  it.each([28, 40, 48])("keeps actual emitted art inside a %i-unit station", stationWidth => {
    for (const pose of ["smoke", "recline", "sleep", "prep"] as const) {
      const bounds = horizontalBounds(draw(pose, stationWidth, 6 * 140, 1));
      expect(Math.min(...bounds)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...bounds)).toBeLessThanOrEqual(stationWidth);
    }
  });

  it("renders a profile eye and two continuous bent legs with distinct planted boots", () => {
    const u = 4, cx = 14 * u, base = 19 * u;
    const graphics = draw("recline", 28, 0, u);
    expect(graphics.rects).toContainEqual({ x: cx - 2 * u, y: base - 17 * u, width: u, height: u, fill: colors.ink });

    const legs = graphics.rects.filter(rect => rect.fill === colors.ink && rect.y >= base - 8 * u);
    expect(legs).toEqual(expect.arrayContaining([
      { x: cx - u, y: base - 8 * u, width: 5 * u, height: 3 * u, fill: colors.ink },
      { x: cx + 3 * u, y: base - 6 * u, width: 2 * u, height: 4 * u, fill: colors.ink },
      { x: cx, y: base - 6 * u, width: 8 * u, height: 2 * u, fill: colors.ink },
      { x: cx + 7 * u, y: base - 4 * u, width: 2 * u, height: 2 * u, fill: colors.ink },
    ]));
    const boots = graphics.rects.filter(rect => colors.boot.includes(rect.fill as typeof colors.boot[number]));
    expect(boots).toHaveLength(2);
    const [rearBoot, frontBoot] = boots;
    expect(rearBoot).toBeDefined();
    expect(frontBoot).toBeDefined();
    expect(boots.map(boot => [boot.x / u, (boot.x + boot.width) / u])).toEqual([[16, 20], [21, 26]]);
    expect((frontBoot!.x - (rearBoot!.x + rearBoot!.width)) / u).toBeGreaterThanOrEqual(1);
    expect(boots.map(boot => boot.y + boot.height)).toEqual([base, base]);
  });

  it("keeps peak smoke and Z marks in the row-safe gap for 6/12-row spacing", () => {
    const u = 4;
    const smoke = draw("smoke", 28, 6 * 140, u);
    expect(Math.min(...smoke.circles.map(mark => mark.y / u))).toBeGreaterThanOrEqual(-3);
    expect(Math.max(...smoke.circles.map(mark => mark.y / u))).toBeLessThanOrEqual(5);
    expect(new Set(smoke.circles.map(mark => mark.y))).toHaveLength(2);

    const sleep = draw("sleep", 28, 3 * 140, u);
    const zYs = sleep.paths.flatMap(path => path.map(point => point.y / u));
    expect(Math.min(...zYs)).toBeGreaterThanOrEqual(-4);
    expect(Math.max(...zYs)).toBeLessThanOrEqual(2);
  });

  it("invalidates animated poses at 140ms without invalidating RECLINE", () => {
    expect(idleAnimationFrame("prep", 139)).toBe(0);
    expect(idleAnimationFrame("prep", 140)).toBe(1);
    expect(idleAnimationFrame("smoke", 1_400)).toBe(10);
    expect(idleAnimationFrame("recline", 0)).toBe(idleAnimationFrame("recline", 10_000));
  });
});

describe("idle pose animation", () => {
  it("uses a calm 4.2-second lift cycle with long stable holds and pixel-unit steps", () => {
    expect(SMOKE_LIFT_CYCLE_MS).toBe(4_200);
    expect(Array.from({ length: 10 }, (_, frame) => smokeLiftUnits(frame * 140))).toEqual(Array(10).fill(0));
    expect(Array.from({ length: 7 }, (_, step) => smokeLiftUnits((10 + step) * 140))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from({ length: 6 }, (_, step) => smokeLiftUnits((17 + step) * 140))).toEqual(Array(6).fill(7));
    expect(Array.from({ length: 7 }, (_, step) => smokeLiftUnits((23 + step) * 140))).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(smokeLiftUnits(SMOKE_LIFT_CYCLE_MS)).toBe(smokeLiftUnits(0));
  });

  it("samples every 140ms with the specified staggered loops", () => {
    expect(sampleIdlePose("prep", 0)).toMatchObject({ frame: 0, prepStep: 0, bobUnits: 0 });
    expect(sampleIdlePose("prep", 140)).toMatchObject({ frame: 1, prepStep: 1, bobUnits: .4 });

    expect(sampleIdlePose("smoke", 5 * 140)).toMatchObject({ handRaised: false, handLiftUnits: 0 });
    expect(sampleIdlePose("smoke", 17 * 140)).toMatchObject({ handRaised: true, handLiftUnits: 7 });
    const smoke = sampleIdlePose("smoke", 6 * 140);
    expect(smoke.handRaised).toBe(false);
    expect(smoke.billows.map(billow => billow.age)).toEqual([6, 13]);
    expect(smoke.billows[0]).toMatchObject({ riseUnits: 3.6, scale: 1.72 });

    const sleep = sampleIdlePose("sleep", 3 * 140);
    expect(sleep.zs.map(z => z.age)).toEqual([3, 0]);
    expect(sampleIdlePose("sleep", 5 * 140).zs[0]?.visible).toBe(false);
    expect(idlePoseIsAnimated("recline")).toBe(false);
    expect(["prep", "smoke", "sleep"].every(pose => idlePoseIsAnimated(pose as "prep"))).toBe(true);
  });
});
