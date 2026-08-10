import type { AgentState } from "../../../protocol/generated/agent-state-event";
import { tokens } from "./tokens";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export interface AnimationDefinition { frames: readonly string[]; frameMs: number; loop: boolean }
export interface SceneTheme {
  id: string;
  spritesheet: string | null;
  animations: Record<AgentState, AnimationDefinition>;
  layout: { stationWidth: number; stationHeight: number; banquetScale: number };
  palette: typeof tokens;
}

const kitchen: SceneTheme = {
  id: "kitchen",
  spritesheet: null,
  animations: {
    idle: { frames: ["chop-0", "chop-1", "chop-2", "chop-3"], frameMs: 140, loop: true },
    working: { frames: ["fire-0", "fire-1", "fire-2", "fire-1"], frameMs: 120, loop: true },
    blocked: { frames: ["bell-0", "bell-1", "bell-2", "bell-1"], frameMs: 140, loop: true },
    done: { frames: ["plate-0", "plate-1", "plate-2", "plate-3"], frameMs: 160, loop: false },
    ended: { frames: ["exit-0", "exit-1", "exit-2", "exit-3"], frameMs: 150, loop: false },
  },
  layout: { stationWidth: 58, stationHeight: 48, banquetScale: 0.8 },
  palette: tokens,
};

const registry = new Map<string, SceneTheme>([[kitchen.id, kitchen]]);
export function registerTheme(theme: SceneTheme) { registry.set(theme.id, theme); }
export function getTheme(id = "kitchen") { const theme = registry.get(id); if (!theme) throw new Error(`Unknown scene theme: ${id}`); return theme; }
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme { return choice === "system" ? (systemDark ? "dark" : "light") : choice; }
export function paletteIndex(theme: ResolvedTheme) { return theme === "dark" ? 1 : 0; }
export function accentIndexForId(id: string) { let value = 2166136261; for (let index = 0; index < id.length; index++) { value ^= id.charCodeAt(index); value = Math.imul(value, 16777619); } return (value >>> 0) % tokens.accents.length; }
