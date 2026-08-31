import { tokens } from "../theme/tokens";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface StationLayout extends Rect {
  id: string;
  scale: number;
  row: number;
  column: number;
}
export interface SceneLayout {
  unit: number;
  wall: Rect;
  pass: Rect;
  stations: StationLayout[];
  columns: number;
  rows: number;
  banquet: boolean;
}
export interface StationVisualMetrics {
  cookHeight: number;
  counterHeight: number;
  labelFontSize: number;
  stationBottom: number;
}
export interface FreezerLayout {
  room: Rect;
  inner: Rect;
  door: Rect;
  racks: readonly Rect[];
  frost: readonly Rect[];
  emptyPill: Rect;
  floor: Rect;
  spirits: readonly (Rect & { id: string })[];
}
export function columnCount(count: number) {
  if (count <= 4) return Math.max(1, count);
  if (count <= 6) return 3;
  if (count <= 8) return 4;
  return Math.min(6, count);
}
export function computeLayout(
  width: number,
  height: number,
  ids: readonly string[],
): SceneLayout {
  // Favor readable pixel clusters at laptop-height viewports. The former floor()
  // dropped 1280x633 to 3px units, leaving almost half the floor unoccupied.
  const unit = Math.max(
    3,
    Math.floor(Math.min(width / 300, height / 185) + 0.75),
  );
  const sceneWidth = width / unit,
    sceneHeight = height / unit;
  const wallHeight = Math.min(56, Math.max(42, sceneHeight * 0.3));
  const passWidth = Math.min(132, sceneWidth * 0.52);
  const columns = columnCount(ids.length),
    rows = Math.max(1, Math.ceil(ids.length / columns)),
    banquet = ids.length > 8,
    scale = banquet ? 0.8 : ids.length <= 2 ? 1.2 : 1;
  const gridTop = wallHeight + 25;
  const availableHeight = Math.max(36 * scale, sceneHeight - gridTop - 4);
  const cellHeight = Math.min(
    banquet ? 42 : 45 * scale,
    availableHeight / rows,
  );
  const cellWidth = Math.min(48 * scale, (sceneWidth - 14) / columns);
  const gridWidth = cellWidth * columns;
  const left = (sceneWidth - gridWidth) / 2;
  const stations = ids.map((id, index) => ({
    id,
    row: Math.floor(index / columns),
    column: index % columns,
    scale,
    x: (left + (index % columns) * cellWidth) * unit,
    y: (gridTop + Math.floor(index / columns) * cellHeight) * unit,
    width: cellWidth * unit,
    height: cellHeight * unit,
  }));
  return {
    unit,
    wall: { x: 0, y: 0, width, height: wallHeight * unit },
    pass: {
      x: ((sceneWidth - passWidth) * unit) / 2,
      y: (wallHeight + 3) * unit,
      width: passWidth * unit,
      height: 18 * unit,
    },
    stations,
    columns,
    rows,
    banquet,
  };
}
export function stationVisualMetrics(
  layout: SceneLayout,
  station: StationLayout,
): StationVisualMetrics {
  const u = layout.unit * station.scale;
  return {
    cookHeight: 25 * u,
    counterHeight: 13.5 * u,
    labelFontSize: Math.max(10, 2.5 * u),
    stationBottom: station.y + station.height,
  };
}

export function computeFreezerLayout(
  width: number,
  height: number,
  boardIds: readonly string[],
): FreezerLayout {
  const freezer = tokens.freezer,
    frame = Math.max(
      freezer.frame.min,
      Math.min(freezer.frame.max, width * freezer.frame.widthRatio),
    ),
    inner = {
      x: frame,
      y: frame,
      width: Math.max(0, width - frame * 2),
      height: Math.max(0, height - frame * 2),
    },
    rackWidth = Math.min(
      freezer.rack.maxWidth,
      Math.max(freezer.rack.minWidth, inner.width * freezer.rack.widthRatio),
    ),
    doorWidth = Math.min(
      freezer.door.maxWidth,
      Math.max(freezer.door.minWidth, inner.width * freezer.door.widthRatio),
    ),
    doorHeight = Math.min(
      freezer.door.maxHeight,
      Math.max(freezer.door.minHeight, inner.height * freezer.door.heightRatio),
    ),
    door = {
      x: width / 2 - doorWidth / 2,
      y: frame + freezer.door.top,
      width: doorWidth,
      height: doorHeight,
    },
    racks = [
      {
        x: frame + freezer.rack.inset,
        y: frame + freezer.rack.top,
        width: rackWidth,
        height: Math.max(
          freezer.rack.minHeight,
          inner.height - freezer.rack.top - freezer.rack.bottom,
        ),
      },
      {
        x: width - frame - rackWidth - freezer.rack.inset,
        y: frame + freezer.rack.top,
        width: rackWidth,
        height: Math.max(
          freezer.rack.minHeight,
          inner.height - freezer.rack.top - freezer.rack.bottom,
        ),
      },
    ],
    frost = [
      {
        x: frame,
        y: frame,
        width: inner.width,
        height: freezer.frost.topHeight,
      },
      {
        x: frame,
        y: height - frame - freezer.frost.bottomHeight,
        width: inner.width,
        height: freezer.frost.bottomHeight,
      },
      {
        x: door.x - freezer.frost.door.x,
        y: door.y + door.height - freezer.frost.door.y,
        width: door.width + freezer.frost.door.x * 2,
        height: freezer.frost.door.height,
      },
      ...racks.map((rack) => ({
        x: rack.x - freezer.frost.rack.x,
        y: rack.y + rack.height - freezer.frost.rack.y,
        width: rack.width + freezer.frost.rack.x * 2,
        height: freezer.frost.rack.height,
      })),
    ],
    emptyPill = {
      x: width / 2 - Math.min(freezer.emptyPill.width, inner.width) / 2,
      y:
        height * (1 - freezer.emptyPill.bottomRatio) - freezer.emptyPill.height,
      width: Math.min(freezer.emptyPill.width, inner.width),
      height: freezer.emptyPill.height,
    },
    floor = {
      x: racks[0]!.x + racks[0]!.width + freezer.rack.floorGap,
      y: door.y + door.height + freezer.door.floorGap,
      width: Math.max(
        0,
        racks[1]!.x -
          (racks[0]!.x + racks[0]!.width) -
          freezer.rack.floorGap * 2,
      ),
      height: Math.max(
        0,
        emptyPill.y - (door.y + door.height + freezer.door.floorGap),
      ),
    },
    slotWidth = freezer.slot.width,
    slotHeight = freezer.slot.height,
    columns = Math.max(0, Math.floor(floor.width / slotWidth)),
    rows = Math.max(0, Math.floor(floor.height / slotHeight)),
    capacity = columns * rows,
    visible = capacity ? boardIds.slice(-capacity) : [],
    usedColumns = Math.min(columns, Math.max(1, visible.length)),
    spirits = visible.map((id, index) => {
      const row = Math.floor(index / usedColumns),
        count = Math.min(usedColumns, visible.length - row * usedColumns),
        column = index % usedColumns,
        extraGap =
          row % 2 && count > 1
            ? Math.min(12, (floor.width - count * slotWidth) / (count - 1))
            : 0,
        pitch = slotWidth + Math.max(0, extraGap),
        rowWidth = slotWidth + (count - 1) * pitch,
        x = floor.x + (floor.width - rowWidth) / 2 + column * pitch;
      return {
        id,
        x,
        y: floor.y + row * slotHeight,
        width: slotWidth,
        height: slotHeight,
      };
    });
  return {
    room: { x: 0, y: 0, width, height },
    inner,
    door,
    racks,
    frost,
    emptyPill,
    floor,
    spirits,
  };
}
