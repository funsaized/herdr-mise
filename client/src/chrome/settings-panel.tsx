import type { ReactNode } from "react";
import { resumeBellAudio } from "../sound/bell";
import type { Settings } from "../state/store";
import { FocusedPanel } from "./panel-support";

function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange(): void;
}) {
  return (
    <button
      role="switch"
      aria-label={label}
      aria-checked={on}
      className={`toggle ${on ? "on" : ""}`}
      onClick={onChange}
    >
      <i />
    </button>
  );
}

export function SettingsPanel({
  settings,
  persistenceFailed = false,
  onChange,
  onClose,
}: {
  settings: Settings;
  persistenceFailed?: boolean;
  onChange(patch: Partial<Settings>): void;
  onClose(): void;
}) {
  const toggleSound = () => {
    if (!settings.sound) void resumeBellAudio();
    onChange({ sound: !settings.sound });
  };
  return (
    <FocusedPanel className="panel settingsPanel" label="Settings" modal>
      <header className="settingsHeader">
        <h2>Settings</h2>
        <button onClick={onClose} aria-label="Close settings">
          ✕
        </button>
      </header>
      {persistenceFailed && (
        <p className="settingsWarning" role="status">
          Settings changed for this session but could not be saved.
        </p>
      )}
      <SettingRow title="Service bell" note="Single ding when an agent blocks">
        <Toggle
          label="Service bell"
          on={settings.sound}
          onChange={toggleSound}
        />
      </SettingRow>
      <SettingRow title="Kitchen atmosphere" note="Steam over working stations">
        <Toggle
          label="Kitchen atmosphere"
          on={settings.atmosphere}
          onChange={() => onChange({ atmosphere: !settings.atmosphere })}
        />
      </SettingRow>
      <section className="settingBlock">
        <b>Theme</b>
        <div className="segments">
          {(
            [
              ["light", "Light"],
              ["dark", "Dinner"],
              ["system", "System"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={settings.theme === value}
              onClick={() => onChange({ theme: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      <SettingRow title="Done timeout" note="Busser clears plated dishes after">
        <select
          aria-label="Done timeout"
          value={settings.doneTimeoutMs}
          onChange={(event) =>
            onChange({ doneTimeoutMs: Number(event.target.value) })
          }
        >
          <option value={300000}>5 min</option>
          <option value={600000}>10 min</option>
          <option value={1200000}>20 min</option>
        </select>
      </SettingRow>
      <section className="settingBlock">
        <b>Blocked escalation</b>
        <label>
          Faster bell after{" "}
          <select
            aria-label="Faster bell after"
            value={settings.escalationFastMs}
            onChange={(event) =>
              onChange({ escalationFastMs: Number(event.target.value) })
            }
          >
            <option value={30000}>30 sec</option>
            <option value={60000}>1 min</option>
            <option value={120000}>2 min</option>
          </select>
        </label>
        <label>
          Screen-edge glow after{" "}
          <select
            aria-label="Screen-edge glow after"
            value={settings.escalationVignetteMs}
            onChange={(event) =>
              onChange({ escalationVignetteMs: Number(event.target.value) })
            }
          >
            <option value={180000}>3 min</option>
            <option value={300000}>5 min</option>
            <option value={600000}>10 min</option>
          </select>
        </label>
      </section>
    </FocusedPanel>
  );
}

function SettingRow({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="settingRow">
      <div>
        <b>{title}</b>
        <small>{note}</small>
      </div>
      {children}
    </section>
  );
}
