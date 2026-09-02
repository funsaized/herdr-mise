import { describe, expect, it } from "vitest";
import type { Graphics } from "pixi.js";
import { tokens } from "../theme/tokens";
import {
  assignedIdlePose,
  drawIdlePose,
  drawPrepPose,
  idleAnimationFrame,
  idlePoseIsAnimated,
  IDLE_POSES,
  IdlePoseAssignments,
  prepFrameInterval,
  reducedIdlePoseSample,
  sampleIdlePose,
  samplePrepPose,
  type IdlePose,
} from "./idle-poses";

interface RecordedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: unknown;
}

class RecordingGraphics {
  circles: Array<{ x: number; y: number; radius: number }> = [];
  rects: RecordedRect[] = [];
  ellipses: Array<{ x: number; y: number; radiusX: number; radiusY: number }> =
    [];
  paths: Array<Array<{ x: number; y: number }>> = [];
  private path: Array<{ x: number; y: number }> = [];
  private pendingRect?: RecordedRect;

  rect(x: number, y: number, width: number, height: number) {
    const rect = { x, y, width, height };
    this.rects.push(rect);
    this.pendingRect = rect;
    return this;
  }
  ellipse(x: number, y: number, radiusX: number, radiusY: number) {
    this.ellipses.push({ x, y, radiusX, radiusY });
    this.pendingRect = undefined;
    return this;
  }
  fill(color?: unknown) {
    if (this.pendingRect) this.pendingRect.fill = color;
    this.pendingRect = undefined;
    return this;
  }
  circle(x: number, y: number, radius: number) {
    this.circles.push({ x, y, radius });
    return this;
  }
  moveTo(x: number, y: number) {
    this.path = [{ x, y }];
    this.paths.push(this.path);
    return this;
  }
  lineTo(x: number, y: number) {
    this.path.push({ x, y });
    return this;
  }
  stroke() {
    return this;
  }
}

const colors = {
  coat: "coat",
  skin: "skin",
  ink: "ink",
  accent: "accent",
  wood: "wood",
  boot: ["boot-0", "boot-1"],
  chair: ["chair-0", "chair-1"],
} as const;

const draw = (pose: IdlePose, stationWidth: number, elapsedMs = 0, u = 4) => {
  const graphics = new RecordingGraphics();
  drawIdlePose(
    graphics as unknown as Graphics,
    pose,
    sampleIdlePose(pose, elapsedMs),
    (stationWidth * u) / 2,
    19 * u,
    u,
    colors,
  );
  return graphics;
};

const horizontalBounds = (graphics: RecordingGraphics) => [
  ...graphics.rects.flatMap((rect) => [rect.x, rect.x + rect.width]),
  ...graphics.circles.flatMap((circle) => [
    circle.x - circle.radius,
    circle.x + circle.radius,
  ]),
  ...graphics.ellipses.flatMap((ellipse) => [
    ellipse.x - ellipse.radiusX,
    ellipse.x + ellipse.radiusX,
  ]),
  ...graphics.paths.flatMap((path) => path.map((point) => point.x)),
];

describe("idle pose assignment", () => {
  it("cycles every sparse idle pose and keeps an agent stable for the session", () => {
    const assignments = new IdlePoseAssignments(() => 0);
    const ids = ["a", "b", "c", "d", "e", "f"];

    expect(ids.map((id) => assignments.for(id))).toEqual([
      "coffeeBreak",
      "lean",
      "sleep",
      "toqueAdjust",
      "ticketRailGlance",
      "coffeeBreak",
    ]);
    expect(assignments.for("c")).toBe("sleep");
    expect(new Set(ids.slice(0, 5).map((id) => assignments.for(id)))).toEqual(
      new Set(IDLE_POSES),
    );
  });

  it("rotates the balanced pose sequence from a session-random starting point", () => {
    const assignments = new IdlePoseAssignments(() => 0.5);
    expect(["a", "b", "c", "d", "e"].map((id) => assignments.for(id))).toEqual([
      "sleep",
      "toqueAdjust",
      "ticketRailGlance",
      "coffeeBreak",
      "lean",
    ]);
  });

  it("assigns decoration only to operationally idle agents", () => {
    const assignments = new IdlePoseAssignments(() => 0);
    expect(assignedIdlePose("idle", "a", assignments)).toBe("coffeeBreak");
    for (const state of ["working", "blocked", "done", "ended"] as const) {
      expect(assignedIdlePose(state, state, assignments)).toBeNull();
    }
  });
});

describe("idle pose rendering geometry", () => {
  it("emits sleep marks above the cook and clear of the label band", () => {
    const u = 4;
    const sleep = draw("sleep", 40, 3 * 700, u);
    expect(sleep.paths).toHaveLength(2);
    expect(sleep.paths.flat().every((point) => point.y < 30 * u)).toBe(true);
  });

  it.each([28, 40, 48])(
    "keeps actual emitted art inside a %i-unit station",
    (stationWidth) => {
      for (const pose of IDLE_POSES) {
        const bounds = horizontalBounds(draw(pose, stationWidth, 6 * 700, 1));
        expect(Math.min(...bounds)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...bounds)).toBeLessThanOrEqual(stationWidth);
      }
    },
  );

  it("renders a profile eye and two continuous bent legs with distinct planted boots", () => {
    const u = 4,
      cx = 14 * u,
      base = 19 * u;
    const graphics = draw("lean", 28, 0, u);
    expect(graphics.rects).toContainEqual({
      x: cx - 2 * u,
      y: base - 17 * u,
      width: u,
      height: u,
      fill: colors.ink,
    });

    const legs = graphics.rects.filter(
      (rect) => rect.fill === colors.ink && rect.y >= base - 8 * u,
    );
    expect(legs).toEqual(
      expect.arrayContaining([
        {
          x: cx - u,
          y: base - 8 * u,
          width: 5 * u,
          height: 3 * u,
          fill: colors.ink,
        },
        {
          x: cx + 3 * u,
          y: base - 6 * u,
          width: 2 * u,
          height: 4 * u,
          fill: colors.ink,
        },
        {
          x: cx,
          y: base - 6 * u,
          width: 8 * u,
          height: 2 * u,
          fill: colors.ink,
        },
        {
          x: cx + 7 * u,
          y: base - 4 * u,
          width: 2 * u,
          height: 2 * u,
          fill: colors.ink,
        },
      ]),
    );
    const boots = graphics.rects.filter((rect) =>
      colors.boot.includes(rect.fill as (typeof colors.boot)[number]),
    );
    expect(boots).toHaveLength(2);
    const [rearBoot, frontBoot] = boots;
    expect(rearBoot).toBeDefined();
    expect(frontBoot).toBeDefined();
    expect(
      boots.map((boot) => [boot.x / u, (boot.x + boot.width) / u]),
    ).toEqual([
      [16, 20],
      [21, 26],
    ]);
    expect(
      (frontBoot!.x - (rearBoot!.x + rearBoot!.width)) / u,
    ).toBeGreaterThanOrEqual(1);
    expect(boots.map((boot) => boot.y + boot.height)).toEqual([base, base]);
  });

  it("keeps peak Z marks in the row-safe gap for 6/12-row spacing", () => {
    const u = 4;
    const sleep = draw("sleep", 28, 3 * 700, u);
    const zYs = sleep.paths.flatMap((path) => path.map((point) => point.y / u));
    expect(Math.min(...zYs)).toBeGreaterThanOrEqual(-4);
    expect(Math.max(...zYs)).toBeLessThanOrEqual(2);
  });

  it("gives the toque pose two eyes", () => {
    const u = 4,
      cx = 14 * u,
      base = 19 * u;
    const eyes = draw("toqueAdjust", 28, 0, u).rects.filter(
      (rect) =>
        rect.fill === colors.ink &&
        rect.width === u &&
        rect.height === u &&
        rect.y === base - 17 * u,
    );
    expect(eyes).toHaveLength(2);
    expect(eyes.map((eye) => eye.x).sort((a, b) => a - b)).toEqual([
      cx - 2 * u,
      cx + u,
    ]);
  });

  it("moves both ticket-rail eyes left and right in unison", () => {
    const u = 4,
      cx = 14 * u,
      base = 19 * u;
    const inkEyes = (elapsedMs: number) =>
      draw("ticketRailGlance", 28, elapsedMs, u)
        .rects.filter(
          (rect) =>
            rect.fill === colors.ink &&
            rect.width === u &&
            rect.height === u &&
            rect.y === base - 17 * u,
        )
        .map((rect) => rect.x)
        .sort((a, b) => a - b);
    const left = inkEyes(0);
    const right = inkEyes(700);
    const rest = [cx - 2 * u, cx + u];
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expect(left).toEqual(rest.map((x) => x - u));
    expect(right).toEqual(rest.map((x) => x + u));
    expect(right[0]! - left[0]!).toBe(right[1]! - left[1]!);
  });

  it("invalidates sparse poses at 700ms without invalidating LEAN", () => {
    expect(idleAnimationFrame("toqueAdjust", 699)).toBe(0);
    expect(idleAnimationFrame("toqueAdjust", 700)).toBe(1);
    expect(idleAnimationFrame("lean", 0)).toBe(
      idleAnimationFrame("lean", 10_000),
    );
  });
});

describe("idle pose animation", () => {
  it("uses a decoration-free fixed sample for every reduced-motion idle pose", () => {
    for (const pose of IDLE_POSES) {
      const sample = reducedIdlePoseSample(pose);
      expect(sample).toMatchObject({
        frame: 0,
        prepStep: 0,
        bobUnits: 0,
        zs: [],
      });
    }
  });
  it("paces working prep from progress and keeps idle motion sparse", () => {
    expect(samplePrepPose(0, 0)).toMatchObject({
      prepStep: 0,
      bobUnits: 0,
    });
    expect(samplePrepPose(220, 0)).toMatchObject({
      prepStep: 1,
      bobUnits: 0.4,
    });
    expect(samplePrepPose(100, 1).prepStep).toBe(1);
    expect(prepFrameInterval(0)).toBe(220);
    expect(prepFrameInterval(1)).toBe(100);
    const sleep = sampleIdlePose("sleep", 3 * 700);
    expect(sleep.zs.map((z) => z.age)).toEqual([3, 0]);
    expect(sampleIdlePose("sleep", 5 * 700).zs[0]?.visible).toBe(false);
    expect(idlePoseIsAnimated("lean")).toBe(false);
    expect(draw("ticketRailGlance", 28, 700).rects).not.toEqual(
      draw("ticketRailGlance", 28, 0).rects,
    );
    expect(
      ["sleep", "toqueAdjust", "ticketRailGlance"].every((pose) =>
        idlePoseIsAnimated(pose as IdlePose),
      ),
    ).toBe(true);
  });

  it("piles lettuce tomato and meat on the prep board", () => {
    const graphics = new RecordingGraphics();
    drawPrepPose(
      graphics as unknown as Graphics,
      samplePrepPose(0, 0),
      14 * 4,
      19 * 4,
      4,
      colors,
    );
    for (const food of tokens.scene.cook.prep.foods) {
      expect(graphics.rects).toContainEqual({
        x: 14 * 4 + food.geometry[0] * 4,
        y: 19 * 4 + food.geometry[1] * 4,
        width: food.geometry[2] * 4,
        height: food.geometry[3] * 4,
        fill: food.fill,
      });
    }
    expect(
      new Set(tokens.scene.cook.prep.foods.map((food) => food.fill)).size,
    ).toBe(3);
  });
});
