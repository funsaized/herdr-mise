import type { AgentMachine } from "../state/store";
import type { SceneLayout } from "./layout";

export function workspaceDisplayName(workspace: string) {
  const value = workspace.trim();
  if (/^[A-Za-z]:[\\/]*$/.test(value)) return "Unavailable";
  return (
    value
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? "Unavailable"
  );
}

export function stationWorkspaceLabel(workspace: string) {
  return {
    text: workspaceDisplayName(workspace).toUpperCase(),
    signature: workspace,
  };
}

export function compactPixelText(value: string, maxCharacters = 30) {
  const text = value.trim();
  if (text.length <= maxCharacters) return text;
  if (maxCharacters <= 3) return ".".repeat(Math.max(0, maxCharacters));
  return `${text.slice(0, maxCharacters - 3)}...`;
}

export function stationIdentityLabels(
  agent: Pick<AgentMachine, "name" | "workspace"> &
    Partial<Pick<AgentMachine, "answerReceivedUntil">>,
  state: AgentMachine["targetState"],
  now = Date.now(),
  maxCharacters = 30,
) {
  const workspace = workspaceDisplayName(agent.workspace).toUpperCase(),
    labels = {
      idle: "PREP",
      working: "FIRE",
      blocked: "AT THE PASS",
      done: "PLATED",
      ended: "86'D",
    } as const,
    answered = state === "working" && (agent.answerReceivedUntil ?? 0) > now,
    status = answered ? "ANSWER RECEIVED" : labels[state];
  return {
    name: compactPixelText(
      `${agent.name.toUpperCase()} · ${workspace}`,
      maxCharacters,
    ),
    status,
    signature: `${agent.name}:${agent.workspace}`,
  };
}

export function doorGeometry(layout: SceneLayout, ajar: boolean) {
  const u = layout.unit,
    frame = {
      x: layout.wall.width - 34 * u,
      y: layout.wall.height - 36 * u,
      width: (ajar ? 25 : 22) * u,
      height: 36 * u,
    },
    innerPanel = {
      x: layout.wall.width - 31 * u,
      y: frame.y + 3 * u,
      width: (ajar ? 18 : 16) * u,
      height: 31 * u,
    },
    knob = { x: layout.wall.width - 17 * u, y: frame.y + 19 * u, radius: u };
  return { frame, innerPanel, knob };
}

export function passBellGeometry(layout: SceneLayout) {
  const u = layout.unit,
    baseX = layout.pass.x + layout.pass.width - 13 * u;
  return {
    base: { x: baseX, y: layout.pass.y + 4.6 * u },
    center: { x: baseX + 3 * u, y: layout.pass.y + 3 * u },
  };
}

function passLane(layout: SceneLayout, index: number) {
  const count = Math.max(1, layout.stations.length),
    permutations: Partial<Record<number, readonly number[]>> = {
      6: [0, 2, 1, 3, 5, 4],
      12: [0, 3, 1, 4, 2, 6, 5, 9, 7, 10, 8, 11],
    },
    permutation = permutations[count];
  return permutation?.[index] ?? index % count;
}

export function passFrontSlot(layout: SceneLayout, id: string) {
  const stationIndex = layout.stations.findIndex(
      (station) => station.id === id,
    ),
    index =
      stationIndex < 0
        ? sceneIdentityHash(id) % Math.max(1, layout.stations.length)
        : stationIndex,
    u = layout.unit,
    bell = passBellGeometry(layout),
    rightmost = bell.center.x - 13 * u,
    leftmost = layout.pass.x + 8 * u,
    laneCount = Math.max(1, layout.stations.length),
    lane = passLane(layout, index),
    maxSpacing = laneCount >= 4 ? 16 * u : 32 * u,
    spacing = Math.min(
      maxSpacing,
      (rightmost - leftmost) / Math.max(1, laneCount - 1),
    );
  return { x: rightmost - lane * spacing, y: layout.pass.y + 20 * u };
}

export function blockedPassGeometry(layout: SceneLayout, id: string) {
  const cook = passFrontSlot(layout, id),
    u = layout.unit,
    count = layout.stations.length,
    dense = count > 6,
    stationIndex = layout.stations.findIndex((station) => station.id === id),
    index =
      stationIndex < 0
        ? sceneIdentityHash(id) % Math.max(1, count)
        : stationIndex,
    lane = passLane(layout, index),
    attachRight = dense && lane >= count - 3,
    ticketWidth = (dense ? 5 : 6.5) * u,
    timerWidth = (dense ? 7 : 13.4) * u,
    passClusterCenter = cook.x + (attachRight ? 9.25 : dense ? -9.25 : -15) * u;
  return {
    cook,
    ticket: {
      x: passClusterCenter - ticketWidth / 2,
      y: layout.pass.y + 8.8 * u,
      width: ticketWidth,
      height: 7.6 * u,
    },
    timer: {
      x: passClusterCenter - timerWidth / 2,
      y: layout.pass.y + 18.2 * u,
      width: timerWidth,
      height: 4.4 * u,
    },
    bell: passBellGeometry(layout).center,
  };
}

export function stationTicketGeometry(
  state: AgentMachine["targetState"],
  u: number,
) {
  return state === "idle"
    ? null
    : {
        x: 6 * u,
        y: 2.5 * u,
        width: 7 * u,
        height: 9 * u,
        blocked: state === "blocked",
      };
}

export function donePlateGeometry(
  stationWidth: number,
  u: number,
  counterY: number,
) {
  const center = {
      x: Math.min(stationWidth - 14 * u, stationWidth / 2 + 8 * u),
      y: counterY - u,
    },
    radius = { x: 7 * u, y: 2 * u },
    rays = [
      { x: center.x - u / 2, y: center.y - 8 * u, width: u, height: 3 * u },
      { x: center.x - 7 * u, y: center.y - 6 * u, width: 2 * u, height: u },
      { x: center.x + 5 * u, y: center.y - 6 * u, width: 2 * u, height: u },
      { x: center.x - 10 * u, y: center.y - 2 * u, width: 3 * u, height: u },
      { x: center.x + 7 * u, y: center.y - 2 * u, width: 3 * u, height: u },
    ];
  return { center, radius, rays };
}

export function sceneIdentityHash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}
