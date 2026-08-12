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
