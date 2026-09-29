import { useEffect, useRef, useState, type ReactNode } from "react";
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
  notificationDeliveryFailed = false,
  onChange,
  onClose,
}: {
  settings: Settings;
  notificationDeliveryFailed?: boolean;
  onChange(patch: Partial<Settings>): void;
  onClose(): void;
}) {
  const toggleSound = () => {
    if (!settings.sound) void resumeBellAudio();
    onChange({ sound: !settings.sound });
  };
  const [permissionStatus, setPermissionStatus] = useState("");
  const request = useRef(0);
  const pending = useRef(false);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const toggleNotifications = () => {
    const generation = ++request.current;
    if (pending.current) {
      pending.current = false;
      setPermissionStatus("Permission request cancelled");
      return;
    }
    if (settings.desktopNotifications) {
      onChange({ desktopNotifications: false });
      setPermissionStatus("Desktop notifications off");
      return;
    }
    if (typeof Notification === "undefined") {
      setPermissionStatus(
        "Desktop notifications are unavailable in this browser",
      );
      return;
    }
    if (Notification.permission === "granted") {
      onChange({ desktopNotifications: true });
      setPermissionStatus("Desktop notifications on while this page is open");
      return;
    }
    if (Notification.permission === "denied") {
      setPermissionStatus("Notifications are blocked by browser settings");
      return;
    }
    try {
      pending.current = true;
      void Notification.requestPermission()
        .then((permission) => {
          if (request.current !== generation) return;
          pending.current = false;
          if (permission === "granted") {
            onChange({ desktopNotifications: true });
            setPermissionStatus(
              "Desktop notifications on while this page is open",
            );
          } else setPermissionStatus("Notifications were not allowed");
        })
        .catch(() => {
          if (request.current === generation) {
            pending.current = false;
            setPermissionStatus("Permission request failed");
          }
        });
    } catch {
      pending.current = false;
      setPermissionStatus("Permission request failed");
    }
  };
  return (
    <FocusedPanel className="panel settingsPanel" label="Settings">
      <header className="settingsHeader">
        <h2>Settings</h2>
        <button onClick={onClose} aria-label="Close settings">
          ✕
        </button>
      </header>
      <SettingRow title="Service bell" note="Single ding when an agent blocks">
        <Toggle
          label="Service bell"
          on={settings.sound}
          onChange={toggleSound}
        />
      </SettingRow>
      <SettingRow
        title="Desktop notifications"
        note="Optional, generic blocked alerts while this page is open and hidden"
      >
        <Toggle
          label="Desktop notifications"
          on={settings.desktopNotifications}
          onChange={toggleNotifications}
        />
      </SettingRow>
      <small role="status">
        {settings.desktopNotifications &&
        (typeof Notification === "undefined" ||
          Notification.permission !== "granted")
          ? "Browser permission does not allow notifications; check browser settings"
          : settings.desktopNotifications && notificationDeliveryFailed
            ? "Last notification delivery failed; check browser or OS settings"
            : permissionStatus ||
              (settings.desktopNotifications
                ? "Enabled; browser and OS delivery may vary"
                : "Off by default")}
      </small>
      <SettingRow
        title="Atmosphere"
        note="Working steam, warm light, and freezer frost"
      >
        <Toggle
          label="Atmosphere"
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
      <SettingRow
        title="Done timeout"
        note="Also applies to dishes already plated, preserving elapsed time"
      >
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
