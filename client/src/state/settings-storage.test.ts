import { describe, expect, it } from "vitest";
import { AgentStore, defaultSettings } from "./store";
import {
  loadSettings,
  SETTINGS_STORAGE_KEY,
  type SettingsStorage,
} from "./settings-storage";

class MemoryStorage implements SettingsStorage {
  value: string | null = null;
  getItem(key: string) {
    return key === SETTINGS_STORAGE_KEY ? this.value : null;
  }
  setItem(key: string, value: string) {
    if (key === SETTINGS_STORAGE_KEY) this.value = value;
  }
}

describe("versioned settings persistence", () => {
  it("round-trips every user setting", () => {
    const storage = new MemoryStorage(),
      store = new AgentStore(undefined, {}, storage),
      expected = {
        sound: true,
        theme: "dark" as const,
        doneTimeoutMs: 300_000,
        escalationFastMs: 30_000,
        escalationVignetteMs: 180_000,
      };
    store.setSettings(expected);
    expect(new AgentStore(undefined, {}, storage).snapshot().settings).toEqual(
      expected,
    );
  });
  it.each([
    "not json",
    JSON.stringify({ version: 99, settings: { sound: true } }),
    JSON.stringify({
      version: 1,
      settings: { sound: "yes", theme: "neon", doneTimeoutMs: -1 },
    }),
  ])("uses safe defaults for corrupt or invalid data", (value) => {
    const storage = new MemoryStorage();
    storage.value = value;
    expect(loadSettings(storage, defaultSettings)).toEqual(defaultSettings);
  });
  it("keeps valid fields and defaults invalid fields in a current-version record", () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({
      version: 1,
      settings: {
        sound: true,
        theme: "nope",
        doneTimeoutMs: 300_000,
        escalationFastMs: 30_000,
        escalationVignetteMs: 180_000,
      },
    });
    expect(loadSettings(storage, defaultSettings)).toEqual({
      ...defaultSettings,
      sound: true,
      doneTimeoutMs: 300_000,
      escalationFastMs: 30_000,
      escalationVignetteMs: 180_000,
    });
  });
  it("drops the legacy reduced-motion field from version-1 records", () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({
      version: 1,
      settings: {
        sound: true,
        theme: "dark",
        doneTimeoutMs: 300_000,
        escalationFastMs: 30_000,
        escalationVignetteMs: 180_000,
        reducedMotion: "reduce",
      },
    });
    const settings = loadSettings(storage, defaultSettings);
    expect(settings).toEqual({
      sound: true,
      theme: "dark",
      doneTimeoutMs: 300_000,
      escalationFastMs: 30_000,
      escalationVignetteMs: 180_000,
    });
    expect(settings).not.toHaveProperty("reducedMotion");
  });
});
