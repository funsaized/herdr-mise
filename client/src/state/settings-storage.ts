import type { Settings } from "./store";

export const SETTINGS_STORAGE_KEY = "herdr-mise:settings";
export const SETTINGS_STORAGE_VERSION = 1;

const themes = new Set(["light", "dark", "system"]);
const doneTimeouts = new Set([300_000, 600_000, 1_200_000]);
const fastThresholds = new Set([30_000, 60_000, 120_000]);
const vignetteThresholds = new Set([180_000, 300_000, 600_000]);

export function loadSettings(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  defaults: Settings,
): Settings {
  if (!storage) return { ...defaults };
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...defaults };
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      !value ||
      value.version !== SETTINGS_STORAGE_VERSION ||
      typeof value.settings !== "object" ||
      value.settings === null
    )
      return { ...defaults };
    const settings = value.settings as Record<string, unknown>;
    return {
      sound:
        typeof settings.sound === "boolean" ? settings.sound : defaults.sound,
      atmosphere:
        typeof settings.atmosphere === "boolean"
          ? settings.atmosphere
          : defaults.atmosphere,
      theme:
        typeof settings.theme === "string" && themes.has(settings.theme)
          ? (settings.theme as Settings["theme"])
          : defaults.theme,
      doneTimeoutMs:
        typeof settings.doneTimeoutMs === "number" &&
        doneTimeouts.has(settings.doneTimeoutMs)
          ? settings.doneTimeoutMs
          : defaults.doneTimeoutMs,
      escalationFastMs:
        typeof settings.escalationFastMs === "number" &&
        fastThresholds.has(settings.escalationFastMs)
          ? settings.escalationFastMs
          : defaults.escalationFastMs,
      escalationVignetteMs:
        typeof settings.escalationVignetteMs === "number" &&
        vignetteThresholds.has(settings.escalationVignetteMs)
          ? settings.escalationVignetteMs
          : defaults.escalationVignetteMs,
    };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  settings: Settings,
) {
  if (!storage) return true;
  try {
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ version: SETTINGS_STORAGE_VERSION, settings }),
    );
    return true;
  } catch {
    return false;
  }
}
