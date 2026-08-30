import { AgentStore } from "./state/store";
import { isVisualMode, parseVisualConfig } from "./visual-harness";
function browserStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
export interface ReducedMotionPreference {
  current(): boolean;
  subscribe(listener: (reduced: boolean) => void): () => void;
}
export function createReducedMotionPreference(
  query: MediaQueryList,
): ReducedMotionPreference {
  return {
    current: () => query.matches,
    subscribe(listener) {
      const handle = (event: MediaQueryListEvent) => listener(event.matches);
      query.addEventListener("change", handle);
      return () => query.removeEventListener("change", handle);
    },
  };
}
const motionQuery = () =>
  typeof matchMedia === "function"
    ? matchMedia("(prefers-reduced-motion: reduce)")
    : ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      } as unknown as MediaQueryList);
export function createRuntimeStore(
  mode: string,
  search: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
) {
  if (isVisualMode(mode)) {
    const config = parseVisualConfig(search);
    return new AgentStore(
      undefined,
      { theme: config.theme },
      new URLSearchParams(search).get("fixture") === "snapshot.v1"
        ? storage
        : null,
    );
  }
  return new AgentStore(undefined, {}, storage);
}
export function createHintPersistence(
  mode: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
) {
  if (isVisualMode(mode)) return { isVisible: () => true, dismiss: () => {} };
  return {
    isVisible: () => storage?.getItem("mise-bell-hint") !== "dismissed",
    dismiss: () => storage?.setItem("mise-bell-hint", "dismissed"),
  };
}
export const clientStore = createRuntimeStore(
  import.meta.env.MODE,
  typeof location === "undefined" ? "" : location.search,
  browserStorage(),
);
export const hintPersistence = createHintPersistence(
  import.meta.env.MODE,
  browserStorage(),
);
export const reducedMotionPreference =
  createReducedMotionPreference(motionQuery());
