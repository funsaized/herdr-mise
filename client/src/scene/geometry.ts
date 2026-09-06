import type { AgentMachine } from "../state/store";
import { tokens } from "../theme/tokens";
import type { Rect, SceneLayout } from "./layout";

export interface BlockedPlacement {
  id: string;
  kind: "pass" | "station";
  queueOrdinal: number;
  queueTotal: number;
  cook: { x: number; y: number };
  cookBounds: Rect;
  ticket: Rect;
  timer: Rect;
  station: Rect;
  bell: Rect;
}

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
  blockedPlacement?: Pick<
    BlockedPlacement,
    "kind" | "queueOrdinal" | "queueTotal"
  >,
) {
  const workspace = workspaceDisplayName(agent.workspace).toUpperCase(),
    agentName = agent.name.toUpperCase(),
    compactName =
      maxCharacters <= agentName.length
        ? agentName.length <= maxCharacters
          ? agentName
          : `${agentName.slice(0, Math.floor((maxCharacters - 3) / 2))}...${agentName.slice(-Math.ceil((maxCharacters - 3) / 2))}`
        : compactPixelText(`${agentName} · ${workspace}`, maxCharacters),
    labels = {
      idle: "PREP",
      working: "FIRE",
      blocked: "AT THE PASS",
      done: "PLATED",
      ended: "86'D",
    } as const,
    answered = state === "working" && (agent.answerReceivedUntil ?? 0) > now,
    status = answered
      ? "ANSWER RECEIVED"
      : state === "blocked" && blockedPlacement
        ? `${blockedPlacement.kind === "pass" ? "AT THE PASS" : "BLOCKED AT STATION"} · ${blockedPlacement.queueOrdinal}/${blockedPlacement.queueTotal}`
        : labels[state];
  return {
    name: compactName,
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

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

export function blockedPlacements(
  layout: SceneLayout,
  blockedIds: readonly string[],
  occupied: readonly BlockedPlacement[] = [],
) {
  const ordered = layout.stations
      .filter((station) => blockedIds.includes(station.id))
      .map((station) => station.id),
    total = ordered.length,
    placements = new Map<string, BlockedPlacement>(),
    u = layout.unit,
    blocked = tokens.scene.layout.blocked,
    bellGeometry = passBellGeometry(layout),
    bell = {
      x: bellGeometry.center.x - blocked.bellClearance * u,
      y: bellGeometry.center.y - blocked.bellClearance * u,
      width: blocked.bellSize * u,
      height: blocked.bellSize * u,
    },
    occupiedBounds = occupied.flatMap((placement) => [
      placement.cookBounds,
      placement.ticket,
      placement.timer,
    ]),
    admittedBounds: Rect[] = [],
    left = layout.pass.x + blocked.passInset * u,
    right = bell.x - blocked.passInset * u;
  let cursor = left,
    overflow = false;
  ordered.forEach((id, index) => {
    const station = layout.stations.find((item) => item.id === id)!,
      scale = station.scale,
      cookWidth = blocked.cookWidth * u * scale,
      cookHeight = blocked.cookHeight * u * scale,
      ticketWidth = blocked.ticketWidth * u,
      timerWidth = blocked.timerWidth * u,
      chipWidth = Math.max(ticketWidth, timerWidth),
      clusterWidth = chipWidth + blocked.chipGap * u + cookWidth,
      stationUnit = u * scale,
      homeTicket = stationTicketGeometry("blocked", stationUnit)!,
      stationPlacement = (): BlockedPlacement => {
        const cook = {
            x:
              station.x +
              Math.min(
                Math.max(
                  station.width / 2,
                  blocked.stationCookMinX * stationUnit,
                ),
                station.width - cookWidth / 2,
              ),
            y: station.y + cookHeight,
          },
          timer = {
            x:
              station.x +
              station.width / 2 -
              blocked.stationTimerInset * stationUnit,
            y: station.y + blocked.stationTimerY * stationUnit,
            width: blocked.stationTimerWidth * stationUnit,
            height: blocked.timerHeight * stationUnit,
          };
        return {
          id,
          kind: "station",
          queueOrdinal: index + 1,
          queueTotal: total,
          cook,
          cookBounds: {
            x: cook.x - cookWidth / 2,
            y: cook.y - cookHeight,
            width: cookWidth,
            height: cookHeight,
          },
          ticket: {
            x: station.x + homeTicket.x,
            y: station.y + homeTicket.y,
            width: homeTicket.width,
            height: homeTicket.height,
          },
          timer,
          station,
          bell,
        };
      };
    if (!overflow) {
      let candidate: BlockedPlacement | null = null;
      while (cursor + clusterWidth <= right) {
        const cook = {
            x: cursor + chipWidth + blocked.chipGap * u + cookWidth / 2,
            y: layout.pass.y + blocked.cookY * u,
          },
          next: BlockedPlacement = {
            id,
            kind: "pass",
            queueOrdinal: index + 1,
            queueTotal: total,
            cook,
            cookBounds: {
              x: cook.x - cookWidth / 2,
              y: cook.y - cookHeight,
              width: cookWidth,
              height: cookHeight,
            },
            ticket: {
              x: cursor + (chipWidth - ticketWidth) / 2,
              y: layout.pass.y + blocked.ticketY * u,
              width: ticketWidth,
              height: blocked.ticketHeight * u,
            },
            timer: {
              x: cursor,
              y: layout.pass.y + blocked.timerY * u,
              width: timerWidth,
              height: blocked.timerHeight * u,
            },
            station,
            bell,
          },
          bounds = [next.cookBounds, next.ticket, next.timer];
        if (
          !bounds.some((bound) =>
            [...occupiedBounds, ...admittedBounds, bell].some((other) =>
              intersects(bound, other),
            ),
          )
        ) {
          candidate = next;
          break;
        }
        cursor += blocked.chipGap * u;
      }
      if (candidate) {
        placements.set(id, candidate);
        admittedBounds.push(
          candidate.cookBounds,
          candidate.ticket,
          candidate.timer,
        );
        cursor =
          Math.max(
            candidate.cookBounds.x + candidate.cookBounds.width,
            candidate.ticket.x + candidate.ticket.width,
            candidate.timer.x + candidate.timer.width,
          ) +
          blocked.chipGap * u;
        return;
      }
      overflow = true;
    }
    placements.set(id, stationPlacement());
  });
  return placements;
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
