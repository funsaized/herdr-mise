import type { Graphics } from "pixi.js";

export const IDLE_POSES = ["smoke", "recline", "sleep", "prep"] as const;
export type IdlePose = typeof IDLE_POSES[number];
export const IDLE_FRAME_MS = 140;
export const SMOKE_LIFT_CYCLE_MS = 30 * IDLE_FRAME_MS;

export function smokeLiftUnits(elapsedMs: number) {
  const frame = Math.floor(Math.max(0, elapsedMs) / IDLE_FRAME_MS) % 30;
  if (frame < 10) return 0;
  if (frame < 17) return frame - 9;
  if (frame < 23) return 7;
  return 29 - frame;
}

export interface IdleParticleSample { age: number; riseUnits: number; scale: number; alpha: number; visible: boolean }
export interface IdlePoseSample {
  frame: number;
  prepStep: 0 | 1;
  bobUnits: number;
  handRaised: boolean;
  handLiftUnits: number;
  billows: IdleParticleSample[];
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
    const pose = IDLE_POSES[(this.offset + this.poses.size) % IDLE_POSES.length]!;
    this.poses.set(agentId, pose);
    return pose;
  }

  get(agentId: string) { return this.poses.get(agentId); }
}

export function assignedIdlePose(state: "idle" | "working" | "blocked" | "done" | "ended", agentId: string, assignments: IdlePoseAssignments) {
  return state === "idle" ? assignments.for(agentId) : null;
}

const loopParticle = (frame: number, offset: number, loop: number, risePerFrame: number, scalePerFrame: number, hideLast = false): IdleParticleSample => {
  const age = (frame + offset) % loop;
  return { age, riseUnits: Number((age * risePerFrame).toFixed(2)), scale: Number((1 + age * scalePerFrame).toFixed(2)), alpha: 1 - age / loop, visible: !hideLast || age < loop - 1 };
};

export function sampleIdlePose(pose: IdlePose, elapsedMs: number): IdlePoseSample {
  const frame = Math.floor(Math.max(0, elapsedMs) / IDLE_FRAME_MS);
  const handLiftUnits = pose === "smoke" ? smokeLiftUnits(elapsedMs) : 0;
  return {
    frame,
    prepStep: (frame % 2) as 0 | 1,
    bobUnits: pose === "prep" && frame % 2 ? .4 : 0,
    handRaised: handLiftUnits === 7,
    handLiftUnits,
    billows: pose === "smoke" ? [loopParticle(frame, 0, 14, .6, .12), loopParticle(frame, 7, 14, .6, .12)] : [],
    zs: pose === "sleep" ? [loopParticle(frame, 0, 6, .7, .12, true), loopParticle(frame, 3, 6, .7, .12, true)] : [],
  };
}

export function reducedIdlePoseSample(pose:IdlePose):IdlePoseSample {
  return {...sampleIdlePose(pose,0),billows:[],zs:[]};
}

export function idlePoseIsAnimated(pose: IdlePose) { return pose !== "recline"; }

export function idleAnimationFrame(pose: IdlePose, elapsedMs: number) {
  return idlePoseIsAnimated(pose) ? Math.floor(Math.max(0, elapsedMs) / IDLE_FRAME_MS) : 0;
}

export interface IdlePoseColors {
  coat: string; skin: string; ink: string; accent: string; wood: string;
  boot: readonly [string, string]; chair: readonly [string, string];
  cigarette: readonly [string, string]; smoke: readonly [string, string]; green: string;
}

const RECLINE = {
  eye: [-2, -17, 1, 1],
  rearThigh: [-1, -8, 5, 3], rearShin: [3, -6, 2, 4], rearBoot: [2, -2, 4, 2],
  frontThigh: [0, -6, 8, 2], frontShin: [7, -4, 2, 2], frontBoot: [7, -2, 5, 2],
} as const;

function relativeRect(g: Graphics, cx: number, base: number, u: number, geometry: readonly [number, number, number, number], color: string) {
  const [x, y, width, height] = geometry;
  return g.rect(cx + x * u, base + y * u, width * u, height * u).fill(color);
}

function standingCook(g: Graphics, cx: number, base: number, u: number, colors: IdlePoseColors, bob = 0) {
  const y = base + bob * u;
  g.rect(cx-5*u,y-2*u,3*u,2*u).fill(colors.ink).rect(cx+2*u,y-2*u,3*u,2*u).fill(colors.ink)
    .rect(cx-4*u,y-6*u,3*u,5*u).fill(colors.ink).rect(cx+u,y-6*u,3*u,5*u).fill(colors.ink)
    .rect(cx-6*u,y-15*u,12*u,10*u).fill(colors.ink).rect(cx-5*u,y-14*u,10*u,9*u).fill(colors.coat)
    .rect(cx-4*u,y-12*u,8*u,2*u).fill(colors.accent).rect(cx-4*u,y-19*u,8*u,5*u).fill(colors.ink)
    .rect(cx-3*u,y-18*u,6*u,4*u).fill(colors.skin).rect(cx-2*u,y-17*u,u,u).fill(colors.ink)
    .rect(cx-6*u,y-22*u,12*u,3*u).fill(colors.ink).rect(cx-5*u,y-23*u,10*u,3*u).fill(colors.coat).rect(cx-3*u,y-25*u,6*u,3*u).fill(colors.coat);
  return y;
}

export function drawIdlePose(g: Graphics, pose: IdlePose, sample: IdlePoseSample, cx: number, base: number, u: number, colors: IdlePoseColors) {
  if (pose === "recline") {
    g.rect(cx-10*u,base-12*u,2*u,13*u).fill(colors.chair[0]).rect(cx-9*u,base-2*u,10*u,2*u).fill(colors.chair[1])
      .rect(cx-8*u,base-14*u,9*u,8*u).fill(colors.ink).rect(cx-7*u,base-13*u,8*u,7*u).fill(colors.coat)
      .rect(cx-7*u,base-19*u,6*u,5*u).fill(colors.ink).rect(cx-6*u,base-18*u,5*u,4*u).fill(colors.skin)
      .rect(cx-8*u,base-22*u,9*u,3*u).fill(colors.coat).rect(cx-6*u,base-24*u,5*u,2*u).fill(colors.coat)
      .rect(cx-3*u,base-11*u,3*u,2*u).fill(colors.skin);
    relativeRect(g,cx,base,u,RECLINE.eye,colors.ink);
    relativeRect(g,cx,base,u,RECLINE.rearThigh,colors.ink);
    relativeRect(g,cx,base,u,RECLINE.rearShin,colors.ink);
    relativeRect(g,cx,base,u,RECLINE.frontThigh,colors.ink);
    relativeRect(g,cx,base,u,RECLINE.frontShin,colors.ink);
    relativeRect(g,cx,base,u,RECLINE.rearBoot,colors.boot[0]);
    relativeRect(g,cx,base,u,RECLINE.frontBoot,colors.boot[1]);
    return;
  }
  const y = standingCook(g, cx, base, u, colors, sample.bobUnits);
  if (pose === "prep") {
    const handY = y-(sample.prepStep ? 10 : 8)*u;
    g.rect(cx+4*u,handY,3*u,2*u).fill(colors.skin).rect(cx+6*u,handY-u,5*u,u).fill(colors.ink)
      .rect(cx+2*u,base-u,8*u,u).fill(colors.wood).rect(cx+3*u,base-2*u,2*u,u).fill(colors.green);
  } else if (pose === "smoke") {
    const handY=y-(9+sample.handLiftUnits)*u;
    g.rect(cx+4*u,handY,3*u,2*u).fill(colors.skin).rect(cx+7*u,handY,3*u,Math.max(1,.7*u)).fill(colors.cigarette[0]).rect(cx+9*u,handY,Math.max(1,.8*u),u).fill(colors.cigarette[1]);
    sample.billows.forEach((billow,index)=>g.circle(cx+(5+index*2)*u,y-(14+billow.riseUnits)*u,(1.4+billow.scale)*u).fill({color:colors.smoke[index]!,alpha:billow.alpha*.75}));
    g.ellipse(cx+5*u,base-.5*u,3*u,u).fill(colors.smoke[0]);
  } else {
    g.rect(cx-2*u,y-17*u,4*u,u).fill(colors.ink);
    sample.zs.forEach((z,index)=>{if(z.visible){const x=cx+(6+index*3)*u,zy=y-(20+z.riseUnits)*u,size=(1.2+z.scale*.35)*u;g.moveTo(x,zy).lineTo(x+size,zy).lineTo(x,zy+size).lineTo(x+size,zy+size).stroke({color:colors.ink,width:Math.max(1,u),alpha:z.alpha});}});
  }
}
