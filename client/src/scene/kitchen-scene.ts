import {
  Application,
  CanvasTextPipe,
  CanvasTextSystem,
  Container,
  extensions,
  Graphics,
  GraphicsContextSystem,
  GraphicsPipe,
  Rectangle,
  Text,
  TextureStyle,
  Ticker,
  UPDATE_PRIORITY,
} from "pixi.js";
import type {
  AgentMachine,
  AgentStore,
  BoardEntry,
  StoreEvent,
} from "../state/store";
import { BellController } from "../sound/bell";
import {
  getTheme,
  paletteIndex,
  resolveTheme,
  type ResolvedTheme,
} from "../theme/theme";
import { tokens } from "../theme/tokens";
import {
  computeFreezerLayout,
  computeLayout,
  type FreezerLayout,
  type Rect,
  type SceneLayout,
} from "./layout";
import { ParticlePool } from "./particles";
import { TransitionEngine } from "./transition";
import {
  assignedIdlePose,
  drawIdlePose,
  drawPrepPose,
  idleAnimationFrame,
  IdlePoseAssignments,
  prepFrameInterval,
  reducedIdlePoseSample,
  sampleIdlePose,
  samplePrepPose,
  type IdlePose,
} from "./idle-poses";
import {
  reducedMotionPreference,
  type ReducedMotionPreference,
} from "../runtime";
import {
  blockedPassGeometry,
  compactPixelText,
  donePlateGeometry,
  doorGeometry,
  passBellGeometry,
  sceneIdentityHash,
  stationIdentityLabels,
  stationTicketGeometry,
  stationWorkspaceLabel,
} from "./geometry";

export {
  blockedPassGeometry,
  compactPixelText,
  donePlateGeometry,
  doorGeometry,
  passBellGeometry,
  passFrontSlot,
  stationIdentityLabels,
  stationTicketGeometry,
  stationWorkspaceLabel,
  workspaceDisplayName,
} from "./geometry";

export interface SceneHit {
  kind: "station" | "board" | "spirit";
  id: string;
  rect: Rect;
}
export interface KitchenSceneOptions {
  onHitLayout?: (hits: readonly SceneHit[]) => void;
  systemDark?: MediaQueryList;
  reducedMotion?: ReducedMotionPreference;
}
export interface SceneMetrics {
  drawCalls: number;
  stationRebuilds: number;
  stationDisposals: number;
  idlePoses: Record<string, IdlePose>;
  stationVisuals: Record<
    string,
    { accent: string; idlePose: IdlePose | null; prepStep: 0 | 1 | null }
  >;
  spiritAccents: Record<string, string>;
  blockedIndicators: number;
  stateIndicators: Record<string, number>;
  endedEntries: number;
  view: "kitchen" | "freezer";
  visibleSpirits: number;
  board: {
    headers: string[];
    rows: { id: string; text: string[] }[];
    strokedIds: string[];
  };
  atmosphere: {
    window: number;
    shelf: number;
    pass: number;
  };
  motion: {
    reduced: boolean;
    activeParticles: number;
    activeTransitions: number;
    activeBusserSweeps: number;
    continuous: boolean;
    preferenceChanges: number;
  };
}
export const BOARD_HEADERS = ["COOK", "MISE TIME"] as const;
export function boardPaintStrings(
  entry: Pick<BoardEntry, "name" | "runtimeMs" | "tickets">,
) {
  return [
    entry.name.toUpperCase(),
    entry.runtimeMs === 0 ? "—" : formatElapsed(entry.runtimeMs),
  ] as const;
}
interface StationView {
  node: Container;
  staticBody: Graphics;
  dynamicBody: Graphics;
  selection: Graphics;
  name: Text;
  label: Text;
  timer: Text;
  hit: Rectangle;
  staticSignature: string;
  dynamicSignature: string;
  dataSignature: string;
}
import {
  BusserSweepTimeline,
  shouldDisposeRetainedStation,
  shouldReconcileBusserClear,
  sceneMotionPolicy,
  sceneContinuousMotion,
} from "./lifecycle";
export {
  BUSSER_SWEEP_MS,
  BusserSweepTimeline,
  busserSweepSample,
  shouldDisposeRetainedStation,
  shouldReconcileBusserClear,
  sceneMotionPolicy,
  sceneContinuousMotion,
} from "./lifecycle";
const worldText = (fill: string, fontSize: number) => ({
  fontFamily: getTheme().palette.typography.worldFamily,
  fontSize,
  fill,
  align: "center" as const,
});
extensions.add(
  GraphicsPipe,
  GraphicsContextSystem,
  CanvasTextPipe,
  CanvasTextSystem,
);

export class KitchenScene {
  readonly app = new Application();
  readonly particles = new ParticlePool();
  readonly transitions = new TransitionEngine();
  readonly bell: BellController;
  private readonly ticker = Ticker.system;
  private dirty = true;
  private readonly renderFrame = () => {
    if (this.dirty) {
      this.app.render();
      this.dirty = false;
    }
  };
  private readonly updateFrame = (ticker: Ticker) => this.tick(ticker.deltaMS);
  private room = new Container();
  private stationLayer = new Container();
  private particleLayer = new Container();
  private escalationLayer = new Container();
  private escalationGraphic = new Graphics();
  private escalationSignature = "";
  private busserLayer = new Container();
  private busserSweeps = new BusserSweepTimeline();
  private busserGraphics = new Map<string, Graphics>();
  private boardLayer = new Container();
  private stationNodes = new Map<string, Container>();
  private stationViews = new Map<string, StationView>();
  private steamNodes: Graphics[] = [];
  private stationRebuilds = 0;
  private stationDisposals = 0;
  private readonly idlePoses = new IdlePoseAssignments();
  private readonly stationVisuals: SceneMetrics["stationVisuals"] = {};
  private readonly spiritAccents: SceneMetrics["spiritAccents"] = {};
  private hits: SceneHit[] = [];
  private lastHitSignature = "";
  private focusedId: string | null = null;
  private lastTheme: ResolvedTheme | null = null;
  private lastAtmosphere: boolean | null = null;
  private boardSelection: string | null = null;
  private boardMetrics: SceneMetrics["board"] = {
    headers: [],
    rows: [],
    strokedIds: [],
  };
  private atmosphereMetrics: SceneMetrics["atmosphere"] = {
    window: 0,
    shelf: 0,
    pass: 0,
  };
  private layout!: SceneLayout;
  private freezerLayout: FreezerLayout | null = null;
  private view: "kitchen" | "freezer" = "kitchen";
  private lastLiveIds = "";
  private lastBoardIds = "";
  private unsubscribe: (() => void) | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeMotion: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private visibleHandler = () => this.onVisibility();
  private themeHandler = () => this.redraw();
  private lastSteam = new Map<string, number>();
  private lastVisualUpdate = 0;
  private destroyed = false;
  private currentDrawCalls = 0;
  private lastDrawCalls = 0;
  private reducedMotion: boolean;
  private preferenceChanges = 0;
  private systemDark: MediaQueryList;
  private motionPreference: ReducedMotionPreference;
  private pointerHandler = (event: PointerEvent) => {
    const bounds = this.host.getBoundingClientRect();
    const hit = this.hitTest(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
    if (hit) this.store.select(hit.id);
  };
  constructor(
    private store: AgentStore,
    private host: HTMLElement,
    private options: KitchenSceneOptions = {},
  ) {
    this.systemDark =
      options.systemDark ?? matchMedia("(prefers-color-scheme: dark)");
    this.motionPreference = options.reducedMotion ?? reducedMotionPreference;
    this.reducedMotion = this.motionPreference.current();
    this.bell = new BellController(store);
  }
  async init() {
    TextureStyle.defaultOptions.scaleMode = "nearest";
    await this.app.init({
      width: this.host.clientWidth || innerWidth,
      height: this.host.clientHeight || innerHeight,
      antialias: false,
      preference: "webgl",
      resolution: devicePixelRatio || 1,
      autoStart: false,
      skipExtensionImports: true,
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    this.app.canvas.className = "sceneCanvas";
    this.host.appendChild(this.app.canvas);
    this.app.stage.addChild(
      this.room,
      this.stationLayer,
      this.particleLayer,
      this.escalationLayer,
      this.busserLayer,
    );
    this.escalationLayer.addChild(this.escalationGraphic);
    this.instrumentDrawCalls();
    for (let i = 0; i < this.particles.particles.length; i++) {
      const dot = new Graphics();
      this.steamNodes.push(dot);
      this.particleLayer.addChild(dot);
    }
    this.ticker.add(this.updateFrame);
    this.ticker.add(this.renderFrame, undefined, UPDATE_PRIORITY.LOW);
    this.unsubscribe = this.store.subscribe(() => this.reconcile());
    this.unsubscribeEvents = this.store.onEvent((event) =>
      this.onStoreEvent(event),
    );
    this.unsubscribeMotion = this.motionPreference.subscribe((reduced) =>
      this.onMotionPreference(reduced),
    );
    this.resizeObserver = new ResizeObserver(() => this.redraw());
    this.resizeObserver.observe(this.host);
    this.host.addEventListener("pointerdown", this.pointerHandler);
    document.addEventListener("visibilitychange", this.visibleHandler);
    this.systemDark.addEventListener("change", this.themeHandler);
    this.redraw();
    if (!document.hidden) this.ticker.start();
  }
  destroy() {
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribeEvents?.();
    this.unsubscribeMotion?.();
    this.unsubscribe = null;
    this.unsubscribeEvents = null;
    this.unsubscribeMotion = null;
    this.resizeObserver?.disconnect();
    this.host.removeEventListener("pointerdown", this.pointerHandler);
    document.removeEventListener("visibilitychange", this.visibleHandler);
    this.systemDark.removeEventListener("change", this.themeHandler);
    this.ticker.remove(this.updateFrame);
    this.ticker.remove(this.renderFrame);
    this.bell.destroy();
    this.particles.releaseAll();
    this.busserSweeps.clear();
    this.busserGraphics.clear();
    if (this.app.renderer) this.app.destroy(true);
  }
  hitTest(x: number, y: number) {
    return (
      this.hits.find(
        (hit) =>
          x >= hit.rect.x &&
          y >= hit.rect.y &&
          x <= hit.rect.x + hit.rect.width &&
          y <= hit.rect.y + hit.rect.height,
      ) ?? null
    );
  }
  focus(id: string | null) {
    if (this.focusedId === id) return;
    this.focusedId = id;
    if (this.layout && this.view === "kitchen") {
      this.drawStations(performance.now());
      destroyChildren(this.boardLayer);
      this.drawBoard(paletteIndex(this.resolvedTheme()));
      this.dirty = true;
    } else if (this.view === "freezer") {
      this.redraw();
    }
  }
  setView(view: "kitchen" | "freezer") {
    if (this.view === view) return;
    this.view = view;
    this.redraw();
  }
  metrics(): SceneMetrics {
    const idlePoses: Record<string, IdlePose> = {},
      stateIndicators: Record<string, number> = {},
      snapshot = this.store.snapshot(),
      agents = [...snapshot.agents.values()];
    for (const agent of agents) {
      const pose = this.idlePoses.get(agent.id);
      if (agent.targetState === "idle" && pose) idlePoses[agent.id] = pose;
      stateIndicators[agent.targetState] =
        (stateIndicators[agent.targetState] ?? 0) + 1;
    }
    const activeParticles = this.particles.activeCount,
      activeTransitions = this.transitions.activeCount(),
      activeBusserSweeps = this.busserSweeps.size,
      blockedIndicators = agents.filter(
        (agent) => agent.targetState === "blocked",
      ).length;
    return {
      drawCalls: this.lastDrawCalls,
      stationRebuilds: this.stationRebuilds,
      stationDisposals: this.stationDisposals,
      idlePoses,
      stationVisuals: { ...this.stationVisuals },
      spiritAccents: { ...this.spiritAccents },
      blockedIndicators,
      stateIndicators,
      endedEntries: snapshot.board.length,
      view: this.view,
      visibleSpirits: this.freezerLayout?.spirits.length ?? 0,
      board: this.boardMetrics,
      atmosphere: this.atmosphereMetrics,
      motion: {
        reduced: this.reducedMotion,
        activeParticles,
        activeTransitions,
        activeBusserSweeps,
        continuous: sceneContinuousMotion(this.reducedMotion, agents),
        preferenceChanges: this.preferenceChanges,
      },
    };
  }
  resolvedTheme(): ResolvedTheme {
    return resolveTheme(
      this.store.snapshot().settings.theme,
      this.systemDark.matches,
    );
  }
  reconcile(force = false) {
    const snapshot = this.store.snapshot();
    if (document.hidden) {
      this.ticker.stop();
      return;
    }
    if (snapshot.mode === "disconnected") this.ticker.stop();
    else this.ticker.start();
    const now = performance.now();
    this.store.reconcileRendered(undefined, force);
    if (force) this.transitions.reconcile();
    const ids = [...snapshot.agents.keys()],
      liveIds = ids.join("|"),
      boardIds = snapshot.board.map((entry) => entry.id).join("|"),
      boardSelection = snapshot.board.some(
        (item) => item.id === snapshot.selectedId,
      )
        ? snapshot.selectedId
        : null;
    if (
      !this.layout ||
      liveIds !== this.lastLiveIds ||
      boardIds !== this.lastBoardIds ||
      boardSelection !== this.boardSelection ||
      this.lastTheme !== this.resolvedTheme() ||
      this.lastAtmosphere !== snapshot.settings.atmosphere
    )
      this.redraw();
    else if (this.view === "kitchen") this.drawStations(now);
    this.dirty = true;
  }
  private redraw() {
    if (!this.app.renderer) return;
    const snapshot = this.store.snapshot();
    this.lastTheme = this.resolvedTheme();
    this.lastAtmosphere = snapshot.settings.atmosphere;
    this.lastLiveIds = [...snapshot.agents.keys()].join("|");
    this.lastBoardIds = snapshot.board.map((entry) => entry.id).join("|");
    this.boardSelection = snapshot.board.some(
      (item) => item.id === snapshot.selectedId,
    )
      ? snapshot.selectedId
      : null;
    const width = this.host.clientWidth || innerWidth,
      height = this.host.clientHeight || innerHeight;
    this.layout = computeLayout(width, height, [...snapshot.agents.keys()]);
    this.app.renderer.resize(width, height);
    const kitchen = this.view === "kitchen";
    this.stationLayer.visible = kitchen;
    this.particleLayer.visible = kitchen;
    this.escalationLayer.visible = kitchen;
    this.busserLayer.visible = kitchen;
    this.atmosphereMetrics = { window: 0, shelf: 0, pass: 0 };
    if (kitchen) {
      this.freezerLayout = null;
      this.drawRoom();
      this.drawStations(performance.now());
    } else {
      this.particles.releaseAll();
      this.hits = [];
      this.freezerLayout = computeFreezerLayout(
        width,
        height,
        snapshot.board.map((entry) => entry.id),
      );
      this.drawFreezer();
    }
    this.dirty = true;
  }
  private drawFreezer() {
    const layout = this.freezerLayout;
    if (!layout) return;
    for (const id of Object.keys(this.spiritAccents))
      delete this.spiritAccents[id];
    const p = getTheme().palette,
      index = paletteIndex(this.resolvedTheme()),
      g = new Graphics();
    destroyChildren(this.room);
    g.rect(0, 0, layout.room.width, layout.room.height)
      .fill(p.scene.steel[2][index])
      .rect(
        layout.inner.x,
        layout.inner.y,
        layout.inner.width,
        layout.inner.height,
      )
      .fill(p.scene.steel[0][index])
      .rect(
        layout.floor.x,
        layout.floor.y,
        layout.floor.width,
        layout.floor.height,
      )
      .fill(tokens.freezer.floor[index]);
    const stockFill = {
      meat: tokens.freezer.meat,
      crate: tokens.freezer.crate,
      produce: tokens.freezer.produce,
      sack: p.scene.coat[index],
    } as const;
    const cube = tokens.freezer.cubes,
      cubeSize = cube.size,
      cubeGap = cube.gap;
    for (const stack of cube.stacks) {
      const originX = layout.floor.x + stack.x * layout.floor.width,
        originY = layout.floor.y + stack.y * layout.floor.height;
      stack.cols.forEach((height, col) => {
        for (let level = 0; level < height; level++)
          g.rect(
            originX + col * (cubeSize + cubeGap),
            originY - (level + 1) * (cubeSize + cubeGap),
            cubeSize,
            cubeSize,
          ).fill({
            color: tokens.freezer.ice[index],
            alpha: level % 2 ? 0.7 : 0.95,
          });
      });
    }
    g.rect(
      layout.door.x - tokens.freezer.door.frame,
      layout.door.y - tokens.freezer.door.frame,
      layout.door.width + tokens.freezer.door.frame * 2,
      layout.door.height + tokens.freezer.door.frame * 2,
    )
      .fill(p.scene.ink)
      .rect(layout.door.x, layout.door.y, layout.door.width, layout.door.height)
      .fill(p.scene.steel[1][index])
      .rect(
        layout.door.x + tokens.freezer.door.panelInset,
        layout.door.y + tokens.freezer.door.panelInset,
        layout.door.width - tokens.freezer.door.panelInset * 2,
        layout.door.height - tokens.freezer.door.panelInset * 2,
      )
      .stroke({
        color: p.scene.steel[2][index],
        width: tokens.freezer.door.panelStroke,
      })
      .rect(
        layout.door.x + tokens.freezer.door.hinge.x,
        layout.door.y + tokens.freezer.door.hinge.top,
        tokens.freezer.door.hinge.width,
        tokens.freezer.door.hinge.height,
      )
      .fill(p.scene.ink)
      .rect(
        layout.door.x + tokens.freezer.door.hinge.x,
        layout.door.y + layout.door.height - tokens.freezer.door.hinge.bottom,
        tokens.freezer.door.hinge.width,
        tokens.freezer.door.hinge.height,
      )
      .fill(p.scene.ink)
      .rect(
        layout.door.x + layout.door.width - tokens.freezer.door.latch.right,
        layout.door.y + layout.door.height / 2,
        tokens.freezer.door.latch.width,
        tokens.freezer.door.latch.height,
      )
      .fill(p.scene.ink);
    for (const rack of layout.racks) {
      g.rect(rack.x, rack.y, rack.width, rack.height).stroke({
        color: p.scene.ink,
        width: tokens.freezer.rack.borderWidth,
      });
      for (let shelf = 1; shelf <= tokens.freezer.rack.shelfCount; shelf++) {
        const y =
          rack.y + (rack.height * shelf) / (tokens.freezer.rack.shelfCount + 1);
        g.rect(rack.x, y, rack.width, tokens.freezer.rack.shelfWidth).fill(
          p.scene.ink,
        );
        for (const item of tokens.freezer.rack.stock[shelf - 1] ??
          tokens.freezer.rack.stock[0]!) {
          const lift = item.h * 0.55;
          for (let layer = 0; layer < item.stack; layer++)
            drawShelfFood(
              g,
              rack.x + item.x * rack.width + layer,
              y - item.h - layer * lift,
              item.w * rack.width,
              item.h,
              item.fill,
              stockFill[item.fill],
              p.scene.ink,
              tokens.freezer.ice[index],
              tokens.freezer.rack.fat,
              tokens.freezer.rack.crateRim,
            );
        }
      }
    }
    for (const frost of layout.frost)
      g.rect(frost.x, frost.y, frost.width, frost.height).fill({
        color: p.scene.steel[1][index],
        alpha: tokens.freezer.frost.alpha,
      });
    for (
      let x = tokens.freezer.rivet.start;
      x < layout.room.width;
      x += tokens.freezer.rivet.pitch
    )
      g.circle(x, tokens.freezer.rivet.y, tokens.freezer.rivet.radius)
        .fill(p.scene.ink)
        .circle(
          x,
          layout.room.height - tokens.freezer.rivet.y,
          tokens.freezer.rivet.radius,
        )
        .fill(p.scene.ink);
    this.room.addChild(g);
    const snapshot = this.store.snapshot();
    for (const slot of layout.spirits) {
      const entry = snapshot.board.find((item) => item.id === slot.id);
      if (!entry) continue;
      const spirit = new Graphics(),
        u = Math.max(
          tokens.freezer.spirit.scale.min,
          Math.min(
            tokens.freezer.spirit.scale.max,
            slot.width / tokens.freezer.spirit.scale.slotDivisor,
          ),
        ),
        base = slot.y + slot.height - tokens.freezer.spirit.baseInset;
      const spiritAccent = tokens.accents[entry.accentIndex]!;
      this.spiritAccents[entry.id] = spiritAccent;
      drawFrozenCook(
        spirit,
        slot.x + slot.width / 2,
        base - 4 * u,
        u,
        {
          coat: p.scene.coat[index],
          skin: p.scene.skin,
          ink: p.scene.ink,
          boot: p.scene.boot[index],
          tongue: tokens.freezer.tongue,
        },
        slot.x > layout.floor.x + layout.floor.width / 2 ? -1 : 1,
      );
      if (snapshot.selectedId === entry.id || this.focusedId === entry.id)
        spirit
          .rect(
            slot.x + tokens.freezer.spirit.focusInset,
            slot.y + tokens.freezer.spirit.focusInset,
            slot.width - tokens.freezer.spirit.focusInset * 2,
            slot.height - tokens.freezer.spirit.focusInset * 2,
          )
          .stroke({
            color: p.scene.ink,
            width: tokens.freezer.spirit.focusStroke,
          });
      const name = new Text({
        text: compactPixelText(
          entry.name.toUpperCase(),
          tokens.freezer.slot.nameCharacters,
        ),
        style: worldText(
          p.scene.ink,
          Math.max(
            tokens.freezer.spirit.nameFont.min,
            u * tokens.freezer.spirit.nameFont.scale,
          ),
        ),
      });
      name.anchor.set(0.5, 0);
      name.position.set(
        slot.x + slot.width / 2,
        base + tokens.freezer.spirit.nameOffset,
      );
      this.room.addChild(spirit, name);
      this.hits.push({ kind: "spirit", id: entry.id, rect: slot });
    }
    this.publishHits();
  }
  private drawRoom() {
    const p = getTheme().palette,
      index = paletteIndex(this.resolvedTheme()),
      l = this.layout,
      u = l.unit;
    destroyChildren(this.room);
    this.boardLayer = new Container();
    const room = new Graphics()
      .rect(0, 0, l.wall.width, l.wall.height)
      .fill(p.scene.wall[index])
      .rect(0, l.wall.height * 0.42, l.wall.width, l.wall.height * 0.58)
      .fill(p.scene.wainscot[index]);
    const tileW = 9 * u,
      tileH = 4.5 * u;
    for (let y = l.wall.height * 0.42; y < l.wall.height; y += tileH) {
      const row = Math.round(y / tileH);
      for (let x = row % 2 ? -tileW / 2 : 0; x < l.wall.width; x += tileW)
        room.rect(x, y, tileW, tileH).stroke({
          color: p.scene.grout[index],
          width: Math.max(1, u * 0.25),
        });
    }
    room
      .rect(0, l.wall.height - u, l.wall.width, u)
      .fill(p.scene.trim[index])
      .rect(
        0,
        l.wall.height,
        l.wall.width,
        this.app.renderer.height - l.wall.height,
      )
      .fill(p.scene.floor[index]);
    for (let x = 0; x < l.wall.width; x += 16 * u)
      room
        .moveTo(x, l.wall.height)
        .lineTo(x, this.app.renderer.height)
        .stroke({ color: p.scene.floorSeam[index], width: 1, alpha: 0.35 });
    this.room.addChild(room);
    this.drawWindow(index);
    this.drawBoard(index);
    this.drawShelfAndDoor(index);
    this.drawPass(index);
    this.room.addChild(this.boardLayer);
  }
  private drawWindow(index: number) {
    const p = getTheme().palette,
      atmosphere = p.scene.atmosphere.window,
      u = this.layout.unit,
      dark = index === 1,
      x = 8 * u,
      y = 6 * u,
      w = 26 * u,
      h = 17 * u,
      g = new Graphics()
        .rect(x - 2 * u, y - 2 * u, w + 4 * u, h + 4 * u)
        .fill(p.scene.wood[index])
        .rect(x, y, w, h)
        .fill(p.scene.sky[index]);
    if (this.lastAtmosphere && dark) {
      const [moonX, moonY, moonRadius] = atmosphere.moon;
      g.circle(x + moonX * u, y + moonY * u, moonRadius * u).fill(
        p.scene.cloud,
      );
      for (const point of atmosphere.stars)
        g.circle(
          x + point[0] * u,
          y + point[1] * u,
          Math.max(1, atmosphere.starRadius * u),
        ).fill(p.scene.cloud);
      this.atmosphereMetrics.window = atmosphere.stars.length + 1;
    } else if (this.lastAtmosphere) {
      for (const [cloudX, cloudY, width, height] of atmosphere.clouds)
        g.ellipse(x + cloudX * u, y + cloudY * u, width * u, height * u).fill(
          p.scene.cloud,
        );
      this.atmosphereMetrics.window = atmosphere.clouds.length;
    }
    g.rect(x + w / 2 - u / 2, y, u, h)
      .fill(p.scene.wood[index])
      .rect(x, y + h / 2 - u / 2, w, u)
      .fill(p.scene.wood[index])
      .rect(x + 20 * u, y + h - 4 * u, 3 * u, 3 * u)
      .fill(p.scene.ink)
      .rect(x + 19 * u, y + h - 2 * u, 5 * u, 2 * u)
      .fill(p.scene.ink);
    this.room.addChild(g);
  }
  private drawBoard(index: number) {
    const p = getTheme().palette,
      u = this.layout.unit,
      width = Math.min(92 * u, this.layout.wall.width * 0.36),
      x = (this.layout.wall.width - width) / 2,
      y = 4 * u,
      height = Math.max(22 * u, this.layout.wall.height - 15 * u);
    this.boardMetrics = { headers: [], rows: [], strokedIds: [] };
    this.boardLayer.addChild(
      new Graphics()
        .rect(x - 2 * u, y - 2 * u, width + 4 * u, height + 4 * u)
        .fill(p.scene.wood[index])
        .rect(x, y, width, height)
        .fill(p.scene.chalkboard[index])
        .rect(x + 3 * u, y + 9 * u, 9 * u, Math.max(1, 0.6 * u))
        .fill(p.scene.chalk[index]),
    );
    const title = new Text({
      text: "86",
      style: worldText(p.scene.chalk[index], Math.max(8, 4 * u)),
    });
    title.position.set(x + 3 * u, y + 1 * u);
    const cook = new Text({
        text: BOARD_HEADERS[0],
        style: worldText(p.scene.chalk[index], Math.max(8, 2.1 * u)),
      }),
      headings = new Text({
        text: BOARD_HEADERS[1],
        style: worldText(p.scene.chalk[index], Math.max(8, 2.1 * u)),
      });
    cook.position.set(title.x + title.width, y + 1 * u);
    headings.anchor.set(1, 0);
    headings.position.set(x + width - 3 * u, y + 1 * u);
    this.boardLayer.addChild(title, cook, headings);
    this.boardMetrics.headers = [cook.text, headings.text];
    this.hits = this.hits.filter((hit) => hit.kind !== "board");
    this.store
      .snapshot()
      .board.slice(-3)
      .forEach((entry, i) =>
        this.drawBoardRow(
          entry,
          x + 3 * u,
          y + (12 + i * 6) * u,
          width - 6 * u,
          index,
        ),
      );
  }
  private drawBoardRow(
    entry: BoardEntry,
    x: number,
    y: number,
    width: number,
    index: number,
  ) {
    const p = getTheme().palette,
      u = this.layout.unit,
      stroked =
        this.store.snapshot().selectedId === entry.id ||
        this.focusedId === entry.id;
    if (stroked)
      this.boardLayer.addChild(
        new Graphics()
          .rect(x - u, y - u, width, 5 * u)
          .stroke({ color: p.scene.chalk[index], width: Math.max(1, u * 0.5) }),
      );
    const style = worldText(p.scene.chalk[index], Math.max(8, 2.1 * u)),
      [nameText, factsText] = boardPaintStrings(entry),
      name = new Text({ text: nameText, style }),
      facts = new Text({ text: factsText, style });
    name.position.set(x, y);
    facts.anchor.set(1, 0);
    facts.position.set(x + width, y);
    name.eventMode = "static";
    name.cursor = "pointer";
    name.on("pointertap", () => this.store.select(entry.id));
    this.boardLayer.addChild(name, facts);
    this.boardMetrics.rows.push({
      id: entry.id,
      text: [name.text, facts.text],
    });
    if (stroked) this.boardMetrics.strokedIds.push(entry.id);
    this.hits.push({
      kind: "board",
      id: entry.id,
      rect: { x, y, width, height: 5 * u },
    });
  }
  private drawShelfAndDoor(index: number) {
    const p = getTheme().palette,
      atmosphere = p.scene.atmosphere.shelf,
      u = this.layout.unit,
      x = this.layout.wall.width - 73 * u;
    const shelf = new Graphics()
      .rect(x, 9 * u, 30 * u, 2 * u)
      .fill(p.scene.wood[index]);
    if (this.lastAtmosphere) {
      for (const [potX, potY, width, height] of atmosphere.pots)
        shelf.ellipse(x + potX * u, potY * u, width * u, height * u).stroke({
          color: p.scene.stationName[index],
          width: atmosphere.strokeWidth * u,
        });
      this.atmosphereMetrics.shelf = atmosphere.pots.length;
    }
    this.room.addChild(shelf);
    const door = doorGeometry(
      this.layout,
      this.store.snapshot().mode === "empty",
    );
    this.room.addChild(
      new Graphics()
        .rect(door.frame.x, door.frame.y, door.frame.width, door.frame.height)
        .fill(p.scene.wood[index])
        .rect(
          door.innerPanel.x,
          door.innerPanel.y,
          door.innerPanel.width,
          door.innerPanel.height,
        )
        .fill(p.scene.ink)
        .circle(door.knob.x, door.knob.y, door.knob.radius)
        .fill(p.scene.brass),
    );
  }
  private drawPass(index: number) {
    const p = getTheme().palette,
      atmosphereTokens = p.scene.atmosphere.pass,
      u = this.layout.unit,
      pass = this.layout.pass,
      g = new Graphics(),
      poolAlpha = atmosphereTokens.poolAlpha[index];
    const atmosphere = this.lastAtmosphere;
    if (atmosphere && index === 1) {
      const [poolY, poolWidth, poolHeight, poolOpacity] =
        atmosphereTokens.ambientPool;
      g.ellipse(
        pass.x + pass.width / 2,
        pass.y + poolY * u,
        pass.width * poolWidth,
        poolHeight * u,
      ).fill({ color: p.semantic.tungstenDark, alpha: poolOpacity });
      this.atmosphereMetrics.pass++;
    }
    if (atmosphere)
      for (let i = 1; i <= atmosphereTokens.lampCount; i++) {
        const x = pass.x + (pass.width * i) / (atmosphereTokens.lampCount + 1),
          [stemX, stemY, stemWidth, stemHeight] = atmosphereTokens.stem,
          [topX, topY, topWidth, topHeight] = atmosphereTokens.shadeTop,
          [shadeX, shadeY, shadeWidth, shadeHeight] = atmosphereTokens.shade,
          [rimX, rimY, rimWidth, rimHeight] = atmosphereTokens.rim,
          [bulbX, bulbY, bulbWidth, bulbHeight] = atmosphereTokens.bulb,
          [lightY, lightWidth, lightHeight] = atmosphereTokens.pool;
        g.rect(x + stemX * u, pass.y + stemY * u, stemWidth * u, stemHeight * u)
          .fill(p.scene.ink)
          .rect(x + topX * u, pass.y + topY * u, topWidth * u, topHeight * u)
          .fill(p.scene.brass)
          .rect(
            x + shadeX * u,
            pass.y + shadeY * u,
            shadeWidth * u,
            shadeHeight * u,
          )
          .fill(p.scene.brass)
          .rect(x + rimX * u, pass.y + rimY * u, rimWidth * u, rimHeight * u)
          .fill(p.scene.copper)
          .rect(
            x + bulbX * u,
            pass.y + bulbY * u,
            bulbWidth * u,
            bulbHeight * u,
          )
          .fill(index === 1 ? p.semantic.tungstenDark : p.semantic.tungsten)
          .ellipse(x, pass.y + lightY * u, lightWidth * u, lightHeight * u)
          .fill({
            color: index === 1 ? p.semantic.tungstenDark : p.semantic.tungsten,
            alpha: poolAlpha,
          });
        this.atmosphereMetrics.pass += 2;
      }
    g.rect(pass.x, pass.y + 6 * u, pass.width, 3 * u)
      .fill(p.scene.steel[1][index])
      .rect(pass.x, pass.y + 9 * u, pass.width, 8 * u)
      .fill(p.scene.steel[0][index])
      .rect(pass.x, pass.y + 16 * u, pass.width, 2 * u)
      .fill(p.scene.steel[2][index])
      .rect(pass.x + 2 * u, pass.y + 11 * u, pass.width - 4 * u, 0.7 * u)
      .fill(p.scene.steel[1][index])
      .rect(pass.x + 3 * u, pass.y + 18 * u, pass.width - 6 * u, 3 * u)
      .fill({ color: p.scene.shadow, alpha: 0.3 });
    const bell = passBellGeometry(this.layout);
    g.rect(bell.base.x, bell.base.y, 6 * u, 1.4 * u)
      .fill(p.scene.copper)
      .ellipse(bell.base.x + 3 * u, pass.y + 3.3 * u, 2 * u, 2.6 * u)
      .fill(p.scene.brass)
      .rect(bell.base.x + 2.6 * u, pass.y + 0.2 * u, 0.8 * u, u)
      .fill(p.scene.ink);
    this.room.addChild(g);
  }
  private drawStations(now: number) {
    if (this.view !== "kitchen") return;
    const snapshot = this.store.snapshot(),
      index = paletteIndex(this.resolvedTheme()),
      active = new Set<string>();
    this.hits = this.hits.filter((hit) => hit.kind !== "station");
    for (const station of this.layout.stations) {
      const agent = snapshot.agents.get(station.id);
      if (!agent) continue;
      active.add(agent.id);
      let view = this.stationViews.get(agent.id);
      if (!view) {
        view = this.createStationView(agent);
        this.stationViews.set(agent.id, view);
        this.stationNodes.set(agent.id, view.node);
      }
      this.updateStation(view, agent, station, index, now);
      this.stationLayer.addChild(view.node);
      this.hits.push({ kind: "station", id: agent.id, rect: station });
    }
    for (const [id, view] of this.stationViews)
      if (!active.has(id) && !this.busserSweeps.has(id))
        this.disposeStation(id, view);
    this.publishHits();
  }
  private publishHits() {
    const signature = this.hits
      .map(
        (hit) =>
          `${hit.kind}:${hit.id}:${hit.rect.x}:${hit.rect.y}:${hit.rect.width}:${hit.rect.height}`,
      )
      .join("|");
    if (signature !== this.lastHitSignature) {
      this.lastHitSignature = signature;
      this.options.onHitLayout?.(this.hits);
    }
  }
  private createStationView(agent: AgentMachine): StationView {
    const p = getTheme().palette,
      node = new Container(),
      staticBody = new Graphics(),
      dynamicBody = new Graphics(),
      selection = new Graphics(),
      name = new Text({
        text: stationWorkspaceLabel(agent.workspace).text,
        style: worldText(p.scene.ink, 8),
      }),
      label = new Text({ text: "", style: worldText(p.scene.muted, 8) }),
      timer = new Text({
        text: "",
        style: worldText(p.semantic.blockedText, 8),
      }),
      hit = new Rectangle();
    name.anchor.set(0.5, 0);
    label.anchor.set(0.5, 0);
    timer.anchor.set(0.5, 0);
    timer.visible = false;
    node.hitArea = hit;
    node.addChild(staticBody, dynamicBody, timer, selection, name, label);
    return {
      node,
      staticBody,
      dynamicBody,
      selection,
      name,
      label,
      timer,
      hit,
      staticSignature: "",
      dynamicSignature: "",
      dataSignature: "",
    };
  }
  private updateStation(
    view: StationView,
    agent: AgentMachine,
    rect: Rect & { scale: number },
    index: number,
    now: number,
  ) {
    const snapshot = this.store.snapshot(),
      p = getTheme().palette,
      u = this.layout.unit * rect.scale,
      {
        node,
        staticBody,
        dynamicBody: g,
        selection,
        name,
        label,
        timer,
        hit,
      } = view,
      motion = sceneMotionPolicy(this.reducedMotion);
    node.position.set(rect.x, rect.y);
    hit.x = 0;
    hit.y = -3 * u;
    hit.width = rect.width;
    hit.height = rect.height + 3 * u;
    const state = agent.targetState;
    let transition = motion.transitions
      ? this.transitions.sample(agent.id, now)
      : null;
    if (motion.transitions && agent.renderedState !== state && !transition) {
      this.transitions.target(agent.id, agent.renderedState, state, now);
      transition = this.transitions.sample(agent.id, now);
    }
    const counterY = 19 * u,
      passGeometry = blockedPassGeometry(this.layout, agent.id),
      slot = passGeometry.cook,
      home = { x: rect.x + rect.width / 2, y: rect.y + counterY },
      blockedProgress = motion.travel
        ? transition?.to === "blocked"
          ? transition.progress
          : transition?.from === "blocked"
            ? 1 - transition.progress
            : state === "blocked"
              ? 1
              : 0
        : state === "blocked"
          ? 1
          : 0,
      eased =
        blockedProgress < 0.5
          ? 2 * blockedProgress * blockedProgress
          : 1 - Math.pow(-2 * blockedProgress + 2, 2) / 2,
      cookX = home.x + (slot.x - home.x) * eased - rect.x,
      cookY = home.y + (slot.y - home.y) * eased - rect.y,
      passX = slot.x - rect.x,
      passY = slot.y - rect.y,
      geometrySignature = `${index}:${u}:${rect.width}:${rect.height}:${agent.accentIndex}`;
    if (view.staticSignature !== geometrySignature) {
      const counterWidth = Math.max(20 * u, rect.width - 9 * u),
        left = 4.5 * u,
        accent = tokens.accents[agent.accentIndex]!;
      view.staticSignature = geometrySignature;
      staticBody
        .clear()
        .rect(left, 1.5 * u, counterWidth, u)
        .fill(p.scene.steel[2][index])
        .rect(left, 1.5 * u, u, 6 * u)
        .fill(p.scene.steel[2][index])
        .rect(rect.width - 7 * u, -2 * u, u, 6 * u)
        .fill(p.scene.steel[2][index])
        .rect(rect.width - 6 * u, -2 * u, 5 * u, 3 * u)
        .fill(accent)
        .rect(left, counterY, counterWidth, 2 * u)
        .fill(p.scene.steel[1][index])
        .rect(left, counterY + 2 * u, counterWidth, 7 * u)
        .fill(p.scene.steel[0][index])
        .rect(left, counterY + 3 * u, counterWidth, 0.7 * u)
        .fill({ color: p.scene.steel[1][index], alpha: 0.65 })
        .rect(left, counterY + 9 * u, counterWidth, 1.5 * u)
        .fill(p.scene.steel[2][index])
        .rect(left + 2 * u, counterY + 10.5 * u, 2 * u, 3 * u)
        .fill(p.scene.steel[2][index])
        .rect(left + counterWidth - 4 * u, counterY + 10.5 * u, 2 * u, 3 * u)
        .fill(p.scene.steel[2][index]);
      this.stationRebuilds++;
    }
    const idlePose = assignedIdlePose(state, agent.id, this.idlePoses),
      wallNow = Date.now(),
      elapsed =
        state === "blocked"
          ? Math.max(0, wallNow - Date.parse(agent.stateEnteredAt))
          : 0,
      elapsedText = state === "blocked" ? formatElapsed(elapsed) : "",
      selected = snapshot.selectedId === agent.id,
      focused = this.focusedId === agent.id,
      blockedStage =
        elapsed >= snapshot.settings.escalationVignetteMs
          ? 2
          : elapsed >= snapshot.settings.escalationFastMs
            ? 1
            : 0,
      prepSample = samplePrepPose(motion.cook ? now : 0, agent.progress),
      doneElapsed = Math.max(0, wallNow - Date.parse(agent.stateEnteredAt)),
      doneFlourish =
        motion.cook &&
        state === "done" &&
        doneElapsed < tokens.scene.cook.done.flourishMs,
      animationFrame =
        motion.idle && idlePose
          ? idleAnimationFrame(idlePose, now)
          : motion.cook && state === "working"
            ? prepSample.prepStep
            : motion.cook && state === "blocked"
              ? Math.floor(
                  now / tokens.scene.cook.blocked.frameMs[blockedStage ? 1 : 0],
                )
              : doneFlourish
                ? Math.floor(doneElapsed / tokens.scene.cook.done.frameMs)
                : 0,
      transitionFrame =
        transition && transition.progress < 1
          ? Math.round(transition.progress * 1000)
          : 1000,
      progress =
        agent.progress === null ? "null" : Math.round(agent.progress * 1000),
      identity = stationIdentityLabels(
        agent,
        state,
        wallNow,
        this.layout.banquet ? 18 : 30,
      ),
      dataSignature = `${geometrySignature}:${identity.signature}:${identity.status}:${state}:${agent.stateKnown}:${idlePose ?? "none"}:${progress}:${elapsedText}:${selected}:${focused}:${passX}:${passY}:${this.reducedMotion}`,
      dynamicSignature = `${dataSignature}:${animationFrame}:${transitionFrame}`;
    if (view.dynamicSignature === dynamicSignature) return;
    view.dynamicSignature = dynamicSignature;
    if (view.dataSignature !== dataSignature) {
      view.dataSignature = dataSignature;
      this.stationRebuilds++;
    }
    g.clear();
    selection.clear();
    const homeTicket = stationTicketGeometry(state, u),
      ticketColor =
        state === "done"
          ? p.scene.ticketDone
          : state === "blocked"
            ? p.semantic.blocked
            : p.scene.ticket;
    if (homeTicket) {
      const {
        x: ticketX,
        y: ticketY,
        width: ticketWidth,
        height: ticketHeight,
      } = homeTicket;
      g.rect(ticketX, ticketY, ticketWidth, ticketHeight)
        .fill(ticketColor)
        .rect(ticketX + u, ticketY + 1.5 * u, ticketWidth - 2 * u, 0.7 * u)
        .fill(homeTicket.blocked ? p.scene.ticket : p.scene.shadow)
        .rect(ticketX + u, ticketY + 3.5 * u, ticketWidth - 2 * u, 0.7 * u)
        .fill(homeTicket.blocked ? p.scene.ticket : p.scene.shadow);
      if (state === "working")
        g.rect(
          ticketX,
          ticketY + 8 * u,
          ticketWidth * Math.max(0, Math.min(1, agent.progress ?? 0)),
          u,
        ).fill(p.semantic.done);
      if (state === "done")
        g.moveTo(ticketX + u, ticketY + 4.5 * u)
          .lineTo(ticketX + 3 * u, ticketY + 6.5 * u)
          .lineTo(ticketX + 6 * u, ticketY + 1.5 * u)
          .stroke({ color: p.semantic.done, width: Math.max(1, u) });
    }
    if (state === "blocked")
      g.rect(
        3 * u,
        counterY,
        Math.max(20 * u, rect.width - 6 * u),
        9 * u,
      ).stroke({ color: p.semantic.blocked, width: Math.max(1, u * 0.5) });
    const bob =
        motion.cook && state === "blocked"
          ? Math.sin(
              (now +
                (sceneIdentityHash(agent.id) %
                  tokens.scene.cook.blocked.identitySpreadMs)) /
                tokens.scene.cook.blocked.bobPeriodMs[blockedStage ? 1 : 0],
            ) *
            u *
            tokens.scene.cook.blocked.bobUnits[blockedStage]
          : 0,
      accent = tokens.accents[agent.accentIndex]!,
      poseColors = {
        coat: p.scene.coat[index],
        skin: p.scene.skin,
        ink: p.scene.ink,
        accent,
        wood: p.scene.wood[index],
        boot: p.scene.boot,
        chair: p.scene.chair,
      };
    this.stationVisuals[agent.id] = {
      accent,
      idlePose,
      prepStep: state === "working" ? prepSample.prepStep : null,
    };
    if (idlePose) {
      const sample = motion.idle
        ? sampleIdlePose(idlePose, now)
        : reducedIdlePoseSample(idlePose);
      drawIdlePose(g, idlePose, sample, cookX, cookY, u, poseColors);
    } else if (state === "working")
      drawPrepPose(g, prepSample, cookX, cookY, u, poseColors);
    else
      drawCookSilhouette(
        g,
        cookX,
        cookY + bob,
        u,
        p.scene.coat[index],
        p.scene.skin,
        p.scene.ink,
        accent,
        state,
      );
    if (state === "working") {
      const flicker = prepSample.prepStep,
        potX = rect.width / 2 + 5 * u;
      g.rect(potX - 5 * u, counterY - 4 * u, 10 * u, 4 * u)
        .fill(p.scene.ink)
        .rect(potX - 4 * u, counterY - 5 * u, 8 * u, u)
        .fill(p.scene.steel[2][index])
        .rect(potX + 5 * u, counterY - 3 * u, 3 * u, u)
        .fill(p.scene.steel[2][index])
        .rect(potX - 3 * u, counterY, 2 * u, u)
        .fill(flicker ? p.semantic.flameHighDark : p.semantic.flameDark)
        .rect(potX + u, counterY, 2 * u, u)
        .fill(flicker ? p.semantic.flameDark : p.semantic.flameHighDark);
    }
    if (state === "blocked") {
      const ticket = passGeometry.ticket,
        timerChip = passGeometry.timer,
        ticketX = ticket.x - rect.x,
        ticketY = ticket.y - rect.y,
        timerX = timerChip.x - rect.x,
        timerY = timerChip.y - rect.y;
      g.rect(ticketX, ticketY, ticket.width, ticket.height)
        .fill(p.semantic.blocked)
        .rect(
          ticketX + 0.8 * u,
          ticketY + 1.4 * u,
          ticket.width - 1.6 * u,
          0.7 * u,
        )
        .fill(p.scene.ticket)
        .rect(
          ticketX + 0.8 * u,
          ticketY + 3 * u,
          ticket.width - 1.6 * u,
          0.7 * u,
        )
        .fill(p.scene.ticket)
        .rect(timerX, timerY, timerChip.width, timerChip.height)
        .fill(p.scene.blockedChip);
      timer.text = elapsedText;
      timer.style.fill = p.semantic.blockedText;
      timer.style.fontSize = Math.max(8, 1.6 * u);
      timer.position.set(timerX + timerChip.width / 2, timerY + 0.6 * u);
      timer.visible = true;
    } else timer.visible = false;
    if (state === "done") {
      const plate = donePlateGeometry(rect.width, u, counterY),
        emphasis = index === 1 ? p.semantic.tungstenDark : p.semantic.tungsten;
      if (doneFlourish)
        for (const ray of plate.rays)
          g.rect(ray.x, ray.y, ray.width, ray.height).fill(emphasis);
      g.ellipse(plate.center.x, plate.center.y, plate.radius.x, plate.radius.y)
        .fill(p.scene.ticket)
        .ellipse(
          plate.center.x,
          plate.center.y,
          plate.radius.x - u,
          Math.max(u, plate.radius.y - u),
        )
        .fill({ color: p.semantic.done, alpha: 0.22 })
        .ellipse(
          plate.center.x,
          plate.center.y,
          plate.radius.x - u,
          Math.max(u, plate.radius.y - u),
        )
        .stroke({ color: p.semantic.done, width: Math.max(1, u) });
    }
    if (selected || focused) {
      const color = index === 1 ? p.semantic.flameHighDark : p.scene.ink,
        size = 5 * u,
        w = Math.max(20 * u, rect.width - 2 * u),
        h = Math.min(rect.height, 47 * u);
      selection
        .moveTo(0, size)
        .lineTo(0, 0)
        .lineTo(size, 0)
        .moveTo(w - size, 0)
        .lineTo(w, 0)
        .lineTo(w, size)
        .moveTo(0, h - size)
        .lineTo(0, h)
        .lineTo(size, h)
        .moveTo(w - size, h)
        .lineTo(w, h)
        .lineTo(w, h - size)
        .stroke({ color, width: Math.max(1, u) });
    }
    const colors = p.scene.stationState;
    name.text = identity.name;
    name.style.fill = p.scene.stationName[index];
    name.style.fontSize = Math.max(9, 2.1 * u);
    name.position.set(rect.width / 2, 32 * u);
    label.text =
      agent.stateKnown === false ? "UNKNOWN · PREP" : identity.status;
    label.style.fill = colors[state][index];
    label.style.fontSize = Math.max(8, 1.8 * u);
    label.position.set(rect.width / 2, 37 * u);
    node.alpha = 1;
  }
  private tick(deltaMs: number) {
    this.lastDrawCalls = this.currentDrawCalls;
    this.currentDrawCalls = 0;
    const now = performance.now();
    this.bell.tick(Date.now());
    const snapshot = this.store.snapshot();
    if (snapshot.mode === "disconnected") return;
    if (this.view === "freezer") return;
    const visualInterval = 125;
    if (now - this.lastVisualUpdate >= visualInterval) {
      const visualDelta = this.lastVisualUpdate
        ? now - this.lastVisualUpdate
        : deltaMs;
      this.lastVisualUpdate = now;
      this.store.reconcileRendered();
      const motion = sceneMotionPolicy(this.reducedMotion);
      if (motion.steam) {
        for (const agent of snapshot.agents.values()) {
          if (agent.targetState === "working") {
            const lastSteam = this.lastSteam.get(agent.id) ?? 0;
            if (now - lastSteam < prepFrameInterval(agent.progress)) continue;
            const rect = this.layout.stations.find(
              (item) => item.id === agent.id,
            );
            if (rect) {
              this.particles.acquire(
                rect.x + rect.width / 2,
                rect.y + rect.height * 0.35,
              );
              this.lastSteam.set(agent.id, now);
            }
          }
        }
        for (const id of this.lastSteam.keys())
          if (!snapshot.agents.has(id)) this.lastSteam.delete(id);
        this.particles.update(visualDelta);
      } else {
        this.lastSteam.clear();
        this.particles.releaseAll();
      }
      this.drawParticles();
      this.drawStations(now);
      this.drawEscalation(now);
      if (motion.busser) this.drawBusserSweeps(now);
      this.dirty = true;
    }
  }
  private onStoreEvent(event: StoreEvent) {
    if (event.type === "clear") {
      if (
        shouldReconcileBusserClear(
          new Set(this.busserSweeps.ids()),
          event.agentId,
        )
      )
        this.reconcile();
      return;
    }
    if (event.type !== "busser" || !this.layout) return;
    if (!sceneMotionPolicy(this.reducedMotion).busser) {
      this.reconcile();
      return;
    }
    const rect = this.layout.stations.find(
      (station) => station.id === event.agentId,
    );
    if (!rect) return;
    this.busserSweeps.start(event.agentId, rect, performance.now());
    const prior = this.busserGraphics.get(event.agentId);
    if (prior) {
      this.busserLayer.removeChild(prior);
      prior.destroy();
    }
    const graphic = new Graphics();
    this.busserGraphics.set(event.agentId, graphic);
    this.busserLayer.addChild(graphic);
    if (!document.hidden && this.store.snapshot().mode !== "disconnected")
      this.ticker.start();
  }
  private drawBusserSweeps(now: number) {
    const p = getTheme().palette,
      index = paletteIndex(this.resolvedTheme()),
      u = this.layout.unit;
    for (const id of this.busserSweeps.ids()) {
      const sample = this.busserSweeps.sample(id, now),
        graphic = this.busserGraphics.get(id);
      if (sample && graphic) {
        graphic
          .clear()
          .roundRect(sample.x - 5 * u, sample.y - 1.5 * u, 10 * u, 3 * u, u)
          .fill(p.scene.ticket)
          .rect(sample.x - 4 * u, sample.y + 1.5 * u, 8 * u, u)
          .fill(p.scene.steel[2][index])
          .rect(sample.x - 3 * u, sample.y + 2.5 * u, u, 2 * u)
          .fill(p.scene.chalk[index])
          .rect(sample.x - u, sample.y + 2.5 * u, u, 2 * u)
          .fill(p.scene.chalk[index])
          .rect(sample.x + u, sample.y + 2.5 * u, u, 2 * u)
          .fill(p.scene.chalk[index])
          .rect(sample.x + 3 * u, sample.y + 2.5 * u, u, 2 * u)
          .fill(p.scene.chalk[index]);
        graphic.alpha = sample.alpha;
        continue;
      }
      if (graphic) {
        this.busserLayer.removeChild(graphic);
        graphic.destroy();
        this.busserGraphics.delete(id);
      }
      const view = this.stationViews.get(id),
        liveAgentIds = new Set(this.store.snapshot().agents.keys());
      if (view && shouldDisposeRetainedStation(liveAgentIds, id))
        this.disposeStation(id, view);
    }
  }
  private disposeStation(id: string, view: StationView) {
    this.stationViews.delete(id);
    this.stationNodes.delete(id);
    delete this.stationVisuals[id];
    this.stationLayer.removeChild(view.node);
    view.node.destroy(true);
    this.stationDisposals++;
  }
  private drawEscalation(now: number) {
    const settings = this.store.snapshot().settings,
      blocked = [...this.store.snapshot().agents.values()].filter(
        (agent) => agent.targetState === "blocked",
      ),
      elapsed = blocked.length
        ? Math.max(
            ...blocked.map((agent) =>
              Math.max(0, Date.now() - Date.parse(agent.stateEnteredAt)),
            ),
          )
        : 0,
      stage =
        elapsed >= settings.escalationVignetteMs
          ? 2
          : elapsed >= settings.escalationFastMs
            ? 1
            : 0,
      motion = sceneMotionPolicy(this.reducedMotion),
      pulseFrame =
        motion.escalation && blocked.length ? Math.floor(now / 125) : 0,
      signature = `${blocked.length}:${stage}:${pulseFrame}:${this.reducedMotion}:${this.resolvedTheme()}:${this.layout.unit}:${this.app.renderer.width}:${this.app.renderer.height}`;
    if (signature === this.escalationSignature) return;
    this.escalationSignature = signature;
    const p = getTheme().palette,
      g = this.escalationGraphic,
      bell = passBellGeometry(this.layout).center;
    g.clear();
    if (blocked.length) {
      const period = tokens.scene.cook.blocked.visualBellMs[stage >= 1 ? 1 : 0];
      if (!motion.escalation || now % period < period / 2)
        for (const radius of stage >= 1 ? [3.5, 5.5, 7.5] : [3.5, 5.5])
          g.arc(
            bell.x,
            bell.y,
            radius * this.layout.unit,
            -Math.PI * 0.85,
            -Math.PI * 0.15,
          ).stroke({
            color: p.semantic.blocked,
            width: Math.max(1, this.layout.unit),
          });
    }
    if (stage >= 1)
      g.circle(bell.x, bell.y, 10 * this.layout.unit).fill({
        color: p.semantic.blocked,
        alpha: 0.12,
      });
    if (stage === 2) {
      const pulse = motion.escalation ? 0.2 + Math.sin(now / 400) * 0.06 : 0.2,
        width = this.app.renderer.width,
        height = this.app.renderer.height,
        edge = Math.max(12 * this.layout.unit, Math.min(width, height) * 0.12);
      g.rect(0, 0, width, edge)
        .fill({ color: p.semantic.blocked, alpha: pulse })
        .rect(0, height - edge, width, edge)
        .fill({ color: p.semantic.blocked, alpha: pulse })
        .rect(0, edge, edge, height - edge * 2)
        .fill({ color: p.semantic.blocked, alpha: pulse })
        .rect(width - edge, edge, edge, height - edge * 2)
        .fill({ color: p.semantic.blocked, alpha: pulse });
    }
  }
  private drawParticles() {
    const p = getTheme().palette;
    for (let i = 0; i < this.steamNodes.length; i++) {
      const dot = this.steamNodes[i],
        particle = this.particles.particles[i];
      dot.clear();
      if (particle.active)
        dot.circle(particle.x, particle.y, Math.max(1, this.layout.unit)).fill({
          color: p.scene.cloud,
          alpha: Math.max(0, 1 - particle.age / particle.life),
        });
    }
  }
  private onMotionPreference(reduced: boolean) {
    if (this.reducedMotion === reduced) return;
    this.reducedMotion = reduced;
    this.preferenceChanges++;
    if (reduced) {
      this.particles.releaseAll();
      this.transitions.reconcile();
      this.busserSweeps.clear();
      for (const graphic of this.busserGraphics.values()) {
        this.busserLayer.removeChild(graphic);
        graphic.destroy();
      }
      this.busserGraphics.clear();
      this.drawParticles();
    }
    for (const view of this.stationViews.values()) view.dynamicSignature = "";
    this.escalationSignature = "";
    this.reconcile(true);
    this.drawEscalation(performance.now());
    this.dirty = true;
  }
  private onVisibility() {
    if (document.hidden) this.ticker.stop();
    else {
      this.reconcile(true);
      if (this.store.snapshot().mode !== "disconnected") this.ticker.start();
    }
  }
  private instrumentDrawCalls() {
    const renderer = this.app.renderer as typeof this.app.renderer & {
        gl: {
          drawElements: (
            mode: number,
            count: number,
            type: number,
            offset: number,
          ) => void;
          drawArrays: (mode: number, first: number, count: number) => void;
        };
      },
      gl = renderer.gl,
      drawElements = gl.drawElements.bind(gl),
      drawArrays = gl.drawArrays.bind(gl);
    gl.drawElements = (...args) => {
      this.currentDrawCalls++;
      drawElements(...args);
    };
    gl.drawArrays = (...args) => {
      this.currentDrawCalls++;
      drawArrays(...args);
    };
  }
}
function drawCookSilhouette(
  g: Graphics,
  cx: number,
  base: number,
  u: number,
  coat: string,
  skin: string,
  ink: string,
  accent: string,
  state: AgentMachine["targetState"],
) {
  // A connected 14x21-unit cook: shoes/legs, apron body, arms, face and
  // two-tier toque. Each tier is independently legible at the 0.8x banquet scale.
  g.rect(cx - 5 * u, base - 2 * u, 3 * u, 2 * u)
    .fill(ink)
    .rect(cx + 2 * u, base - 2 * u, 3 * u, 2 * u)
    .fill(ink)
    .rect(cx - 4 * u, base - 6 * u, 3 * u, 5 * u)
    .fill(ink)
    .rect(cx + u, base - 6 * u, 3 * u, 5 * u)
    .fill(ink)
    .rect(cx - 6 * u, base - 15 * u, 12 * u, 10 * u)
    .fill(ink)
    .rect(cx - 5 * u, base - 14 * u, 10 * u, 9 * u)
    .fill(coat)
    .rect(cx - 4 * u, base - 12 * u, 8 * u, 2 * u)
    .fill(accent)
    .rect(cx - 3 * u, base - 10 * u, 6 * u, 5 * u)
    .fill(coat)
    .rect(cx - 6 * u, base - 13 * u, 2 * u, 6 * u)
    .fill(coat)
    .rect(cx + 4 * u, base - 13 * u, 2 * u, 6 * u)
    .fill(coat)
    .rect(cx - 6 * u, base - 8 * u, 2 * u, 2 * u)
    .fill(skin)
    .rect(cx + 4 * u, base - 8 * u, 2 * u, 2 * u)
    .fill(skin)
    .rect(cx - 4 * u, base - 19 * u, 8 * u, 5 * u)
    .fill(ink)
    .rect(cx - 3 * u, base - 18 * u, 6 * u, 4 * u)
    .fill(skin);
  if (state === "ended") {
    for (const eye of [-1.5, 1.5])
      g.moveTo(cx + (eye - 0.6) * u, base - 17.8 * u)
        .lineTo(cx + (eye + 0.6) * u, base - 16.2 * u)
        .moveTo(cx + (eye + 0.6) * u, base - 17.8 * u)
        .lineTo(cx + (eye - 0.6) * u, base - 16.2 * u)
        .stroke({ color: ink, width: Math.max(1, u * 0.55) });
  } else
    g.rect(cx - 2 * u, base - 17 * u, u, u)
      .fill(ink)
      .rect(cx + u, base - 17 * u, u, u)
      .fill(ink);
  g.rect(cx - 6 * u, base - 22 * u, 12 * u, 3 * u)
    .fill(ink)
    .rect(cx - 5 * u, base - 23 * u, 10 * u, 3 * u)
    .fill(coat)
    .rect(cx - 3 * u, base - 25 * u, 6 * u, 3 * u)
    .fill(coat);
  if (state === "done")
    g.rect(cx - 7 * u, base - 11 * u, 4 * u, 2 * u).fill(coat);
}
function drawShelfFood(
  g: Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  kind: "meat" | "crate" | "produce" | "sack",
  fill: string,
  ink: string,
  ice: string,
  fat: string,
  crateRim: string,
) {
  if (kind === "meat") {
    g.rect(x, y, width, height).fill(fill);
    g.rect(x + width * 0.12, y + height * 0.28, width * 0.76, height * 0.16)
      .fill(fat)
      .rect(x + width * 0.18, y + height * 0.58, width * 0.5, height * 0.12)
      .fill(ice);
    g.rect(x + 1, y + 1, width - 2, height - 2).stroke({
      color: ink,
      width: 1,
      alpha: 0.35,
    });
    return;
  }
  if (kind === "sack") {
    g.rect(x + width * 0.28, y, width * 0.44, height * 0.28)
      .fill(fill)
      .rect(x, y + height * 0.18, width, height * 0.82)
      .fill(fill)
      .rect(x + width * 0.12, y + height * 0.4, width * 0.76, 2)
      .fill({ color: ink, alpha: 0.2 });
    return;
  }
  g.rect(x, y, width, height).fill(fill).stroke({ color: crateRim, width: 2 });
  g.rect(x + 4, y + 4, width * 0.32, height * 0.38)
    .fill(ice)
    .rect(x + width * 0.42, y + height * 0.32, width * 0.4, height * 0.42)
    .fill(kind === "produce" ? ice : fat);
}
function drawFrozenCook(
  g: Graphics,
  cx: number,
  cy: number,
  u: number,
  colors: {
    coat: string;
    skin: string;
    ink: string;
    boot: string;
    tongue: string;
  },
  flip: number,
) {
  const cook = tokens.freezer.cook;
  for (const part of cook.parts) {
    const [x, y, width, height] = part.geometry,
      sx = flip < 0 ? -x - width : x;
    g.rect(cx + sx * u, cy + y * u, width * u, height * u).fill(
      colors[part.color],
    );
  }
  const eye = cook.eye;
  for (const ex of cook.eyes) {
    const x = cx + (flip < 0 ? -ex : ex) * u;
    g.moveTo(x - eye.size * u, cy + eye.y0 * u)
      .lineTo(x + eye.size * u, cy + eye.y1 * u)
      .moveTo(x + eye.size * u, cy + eye.y0 * u)
      .lineTo(x - eye.size * u, cy + eye.y1 * u)
      .stroke({ color: colors.ink, width: Math.max(1, u * eye.width) });
  }
}
function formatElapsed(elapsed: number) {
  const seconds = Math.floor(elapsed / 1000),
    minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
function destroyChildren(container: Container) {
  for (const child of container.removeChildren()) child.destroy(true);
}
