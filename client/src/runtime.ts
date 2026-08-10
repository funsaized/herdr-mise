import { AgentStore } from "./state/store";
import type { SettingsStorage } from "./state/settings-storage";
import { isVisualMode, parseVisualConfig } from "./visual-harness";
function browserStorage(){try{return typeof localStorage==="undefined"?null:localStorage;}catch{return null;}}
export function createRuntimeStore(mode: string, search: string, storage: SettingsStorage | null) {
  if (isVisualMode(mode)) {
    const config = parseVisualConfig(search);
    return new AgentStore(undefined, { theme: config.theme }, null);
  }
  return new AgentStore(undefined, {}, storage);
}
export function createHintPersistence(mode: string, storage: Pick<Storage, "getItem" | "setItem"> | null) {
  if (isVisualMode(mode)) return { isVisible: () => true, dismiss: () => {} };
  return { isVisible: () => storage?.getItem("mise-bell-hint") !== "dismissed", dismiss: () => storage?.setItem("mise-bell-hint", "dismissed") };
}
export const clientStore = createRuntimeStore(import.meta.env.MODE, typeof location === "undefined" ? "" : location.search, browserStorage());
export const hintPersistence = createHintPersistence(import.meta.env.MODE, browserStorage());
