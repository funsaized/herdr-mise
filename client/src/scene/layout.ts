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
  totalCount: number;
  capacity: number;
  pageIndex: number;
  pageCount: number;
  visibleIds: readonly string[];
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
  totalSpirits: number;
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
  requestedPage = 0,
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
  const sparse = ids.length <= 2,
    passWidth = Math.min(
      sparse ? tokens.scene.layout.sparsePassWidth : 132,
      sceneWidth * 0.52,
    );
  const preferredColumns = columnCount(ids.length),
    preferredRows = Math.max(1, Math.ceil(ids.length / preferredColumns)),
    banquet = ids.length > 8,
    gridTop = wallHeight + 25,
    sparseScaleFits =
      sceneHeight - gridTop - 4 >=
        tokens.scene.layout.stationHeight * tokens.scene.layout.sparseScale &&
      sceneWidth - 14 >=
        tokens.scene.layout.stationWidth * tokens.scene.layout.sparseScale,
    scale = banquet
      ? tokens.scene.layout.banquetScale
      : sparse && sparseScaleFits
        ? tokens.scene.layout.sparseScale
        : 1,
    gutter = banquet ? 0 : tokens.scene.layout.stationGutter;
  const fullAvailableHeight = Math.max(
    tokens.scene.layout.stationHeight * scale,
    sceneHeight - gridTop - 4,
  );
  const preferredCellHeight = Math.min(
      banquet ? 42 : tokens.scene.layout.stationHeight * scale,
      fullAvailableHeight / preferredRows,
    ),
    preferredCellWidth = Math.min(
      48 * scale,
      (sceneWidth - 14 - gutter * (preferredColumns - 1)) / preferredColumns,
    ),
    minimumWidth = tokens.scene.layout.stationWidth * scale,
    minimumHeight = tokens.scene.layout.stationHeight * scale,
    paged =
      preferredCellWidth < minimumWidth || preferredCellHeight < minimumHeight,
    pagerReservedHeight =
      width >= tokens.scene.layout.compactPagerMinWidth &&
      height <= tokens.scene.layout.compactPagerMaxHeight
        ? tokens.scene.layout.compactPagerReservedHeight
        : tokens.scene.layout.pagerReservedHeight,
    stationGridTop = paged
      ? Math.min(
          gridTop,
          sceneHeight - pagerReservedHeight / unit - minimumHeight,
        )
      : gridTop,
    availableHeight = Math.max(
      minimumHeight,
      sceneHeight - stationGridTop - (paged ? pagerReservedHeight / unit : 4),
    ),
    pageColumns = Math.max(
      1,
      Math.min(
        6,
        Math.floor((sceneWidth - 14 + gutter) / (minimumWidth + gutter)),
      ),
    ),
    pageRows = Math.max(1, Math.floor(availableHeight / minimumHeight)),
    capacity = paged ? pageColumns * pageRows : Math.max(1, ids.length),
    pageCount = Math.max(1, Math.ceil(ids.length / capacity)),
    pageIndex = Math.max(0, Math.min(Math.trunc(requestedPage), pageCount - 1)),
    visibleIds = ids.slice(pageIndex * capacity, (pageIndex + 1) * capacity),
    columns = paged
      ? Math.min(pageColumns, Math.max(1, visibleIds.length))
      : preferredColumns,
    rows = Math.max(1, Math.ceil(visibleIds.length / columns));
  const cellHeight = Math.min(
    banquet
      ? 42
      : (paged
          ? tokens.scene.layout.pagedStationHeight
          : tokens.scene.layout.stationHeight) * scale,
    availableHeight / rows,
  );
  const cellWidth = Math.min(
    48 * scale,
    (sceneWidth - 14 - gutter * (columns - 1)) / columns,
  );
  const gridWidth = cellWidth * columns + gutter * (columns - 1);
  const left = (sceneWidth - gridWidth) / 2;
  const stations = visibleIds.map((id, index) => ({
    id,
    row: Math.floor(index / columns),
    column: index % columns,
    scale,
    x: (left + (index % columns) * (cellWidth + gutter)) * unit,
    y: (stationGridTop + Math.floor(index / columns) * cellHeight) * unit,
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
    totalCount: ids.length,
    capacity,
    pageIndex,
    pageCount,
    visibleIds,
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
        x: frame + freezer.rack.inset,
        y: frame,
        width: rackWidth,
        height: freezer.frost.topHeight,
      },
      {
        x: width - frame - freezer.rack.inset - rackWidth,
        y: frame,
        width: rackWidth,
        height: freezer.frost.topHeight,
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
    sideColumns = Math.max(
      0,
      Math.floor((floor.width - freezer.slot.aisleWidth) / (slotWidth * 2)),
    ),
    columns = sideColumns * 2 || (floor.width >= slotWidth ? 1 : 0),
    rows = Math.max(0, Math.floor(floor.height / slotHeight)),
    capacity = columns * rows,
    visible = capacity ? boardIds.slice(-capacity) : [],
    spirits = visible.map((id, index) => {
      const row = Math.floor(index / columns),
        column = index % columns,
        depth = Math.floor(column / 2),
        x =
          column % 2 === 0
            ? floor.x + depth * slotWidth
            : floor.x + floor.width - (depth + 1) * slotWidth;
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
    totalSpirits: boardIds.length,
  };
}
