import type { Graphics } from "pixi.js";
import { tokens } from "../theme/tokens";

export const IDLE_POSES = [
  "coffeeBreak",
  "lean",
  "sleep",
  "toqueAdjust",
  "ticketRailGlance",
] as const;
export type IdlePose = (typeof IDLE_POSES)[number];
export const IDLE_FRAME_MS = tokens.scene.cook.idleFrameMs;

export interface IdleParticleSample {
  age: number;
  riseUnits: number;
  scale: number;
  alpha: number;
  visible: boolean;
}
export interface IdlePoseSample {
  frame: number;
  prepStep: 0 | 1;
  bobUnits: number;
  zs: IdleParticleSample[];
}

/** Session-local idle-rank assignment, intentionally preserving roster discovery order. */
export class IdlePoseAssignments {
  private readonly poses = new Map<string, IdlePose>();
  private readonly offset: number;

  constructor(random: () => number = Math.random) {
    this.offset = Math.floor(random() * IDLE_POSES.length);
  }

  for(agentId: string): IdlePose {
    const existing = this.poses.get(agentId);
    if (existing) return existing;
    const pose =
      IDLE_POSES[(this.offset + this.poses.size) % IDLE_POSES.length]!;
    this.poses.set(agentId, pose);
    return pose;
  }

  get(agentId: string) {
    return this.poses.get(agentId);
  }
}

export function assignedIdlePose(
  state: "idle" | "working" | "blocked" | "done" | "ended",
  agentId: string,
  assignments: IdlePoseAssignments,
) {
  return state === "idle" ? assignments.for(agentId) : null;
}

const loopParticle = (
  frame: number,
  offset: number,
  loop: number,
  risePerFrame: number,
  scalePerFrame: number,
  hideLast = false,
): IdleParticleSample => {
  const age = (frame + offset) % loop;
  return {
    age,
    riseUnits: Number((age * risePerFrame).toFixed(2)),
    scale: Number((1 + age * scalePerFrame).toFixed(2)),
    alpha: 1 - age / loop,
    visible: !hideLast || age < loop - 1,
  };
};

export function sampleIdlePose(
  pose: IdlePose,
  elapsedMs: number,
): IdlePoseSample {
  const frame = Math.floor(Math.max(0, elapsedMs) / IDLE_FRAME_MS);
  return {
    frame,
    prepStep: (frame % 2) as 0 | 1,
    bobUnits:
      pose === "toqueAdjust" && frame % 2 ? tokens.scene.cook.toqueBobUnits : 0,
    zs:
      pose === "sleep"
        ? tokens.scene.cook.sleep.offsets.map((offset) =>
            loopParticle(
              frame,
              offset,
              tokens.scene.cook.sleep.loopFrames,
              tokens.scene.cook.sleep.risePerFrame,
              tokens.scene.cook.sleep.scalePerFrame,
              true,
            ),
          )
        : [],
  };
}

export function reducedIdlePoseSample(pose: IdlePose): IdlePoseSample {
  return { ...sampleIdlePose(pose, 0), zs: [] };
}

export function idlePoseIsAnimated(pose: IdlePose) {
  return (
    pose === "sleep" || pose === "toqueAdjust" || pose === "ticketRailGlance"
  );
}

export function idleAnimationFrame(pose: IdlePose, elapsedMs: number) {
  return idlePoseIsAnimated(pose)
    ? Math.floor(Math.max(0, elapsedMs) / IDLE_FRAME_MS)
    : 0;
}

export interface IdlePoseColors {
  coat: string;
  skin: string;
  ink: string;
  accent: string;
  wood: string;
  boot: readonly [string, string];
  chair: readonly [string, string];
}

function relativeRect(
  g: Graphics,
  cx: number,
  base: number,
  u: number,
  geometry: readonly [number, number, number, number],
  color: string,
) {
  const [x, y, width, height] = geometry;
  return g.rect(cx + x * u, base + y * u, width * u, height * u).fill(color);
}

function standingCook(
  g: Graphics,
  cx: number,
  base: number,
  u: number,
  colors: IdlePoseColors,
  bob = 0,
  drawEyes = true,
) {
  const y = base + bob * u;
  for (const part of tokens.scene.cook.standing)
    relativeRect(g, cx, y, u, part.geometry, colors[part.color]);
  if (drawEyes)
    for (const eye of tokens.scene.cook.eyes)
      relativeRect(g, cx, y, u, eye, colors.ink);
  return y;
}

export function drawIdlePose(
  g: Graphics,
  pose: IdlePose,
  sample: IdlePoseSample,
  cx: number,
  base: number,
  u: number,
  colors: IdlePoseColors,
) {
  if (pose === "lean") {
    const leanColors = {
      chair0: colors.chair[0],
      chair1: colors.chair[1],
      ink: colors.ink,
      coat: colors.coat,
      skin: colors.skin,
      boot0: colors.boot[0],
      boot1: colors.boot[1],
    };
    for (const part of tokens.scene.cook.lean.parts)
      relativeRect(g, cx, base, u, part.geometry, leanColors[part.color]);
    return;
  }
  const y = standingCook(
    g,
    cx,
    base,
    u,
    colors,
    sample.bobUnits,
    pose !== "sleep" && pose !== "ticketRailGlance",
  );
  if (pose === "coffeeBreak") {
    relativeRect(
      g,
      cx,
      base,
      u,
      tokens.scene.cook.coffeeBreak.cup,
      colors.coat,
    );
    const [x, y, width, height] = tokens.scene.cook.coffeeBreak.handle;
    g.rect(cx + x * u, base + y * u, width * u, height * u).stroke({
      color: colors.ink,
      width: Math.max(1, u),
    });
  } else if (pose === "toqueAdjust") {
    const hand = tokens.scene.cook.toqueAdjust,
      handY = y - hand.handY[sample.prepStep] * u;
    g.rect(cx + hand.handX * u, handY, hand.width * u, hand.height * u).fill(
      colors.skin,
    );
  } else if (pose === "ticketRailGlance") {
    const glance = tokens.scene.cook.ticketRailGlance,
      shift = sample.prepStep ? glance.glanceUnits : -glance.glanceUnits;
    for (const [eyeX, eyeY, eyeWidth, eyeHeight] of tokens.scene.cook.eyes)
      relativeRect(
        g,
        cx,
        y,
        u,
        [eyeX + shift, eyeY, eyeWidth, eyeHeight],
        colors.ink,
      );
    relativeRect(g, cx, base, u, glance.ticket, colors.coat);
  } else {
    const sleep = tokens.scene.cook.sleep;
    relativeRect(g, cx, y, u, sleep.eye, colors.ink);
    sample.zs.forEach((z, index) => {
      if (z.visible) {
        const x = cx + (sleep.markX + index * sleep.markGap) * u,
          zy = y + (sleep.markY - z.riseUnits) * u,
          size = (sleep.markSize + z.scale * sleep.markScale) * u;
        g.moveTo(x, zy)
          .lineTo(x + size, zy)
          .lineTo(x, zy + size)
          .lineTo(x + size, zy + size)
          .stroke({ color: colors.ink, width: Math.max(1, u), alpha: z.alpha });
      }
    });
  }
}

export function prepFrameInterval(progress: number | null) {
  return (
    tokens.scene.cook.prep.slowFrameMs -
    Math.max(0, Math.min(1, progress ?? 0)) *
      tokens.scene.cook.prep.accelerationMs
  );
}

export function samplePrepPose(elapsedMs: number, progress: number | null) {
  const frame = Math.floor(
    Math.max(0, elapsedMs) / prepFrameInterval(progress),
  );
  return {
    prepStep: (frame % 2) as 0 | 1,
    bobUnits: frame % 2 ? tokens.scene.cook.prep.bobUnits : 0,
  };
}

export function drawPrepPose(
  g: Graphics,
  sample: ReturnType<typeof samplePrepPose>,
  cx: number,
  base: number,
  u: number,
  colors: IdlePoseColors,
) {
  const prep = tokens.scene.cook.prep,
    y = standingCook(g, cx, base, u, colors, sample.bobUnits),
    handY = y - prep.handY[sample.prepStep] * u;
  g.rect(cx + prep.handX * u, handY, prep.handWidth * u, prep.handHeight * u)
    .fill(colors.skin)
    .rect(
      cx + prep.knife[0] * u,
      handY + prep.knife[1] * u,
      prep.knife[2] * u,
      prep.knife[3] * u,
    )
    .fill(colors.ink)
    .rect(
      cx + prep.board[0] * u,
      base + prep.board[1] * u,
      prep.board[2] * u,
      prep.board[3] * u,
    )
    .fill(colors.wood);
  for (const food of prep.foods)
    relativeRect(g, cx, base, u, food.geometry, food.fill);
}
