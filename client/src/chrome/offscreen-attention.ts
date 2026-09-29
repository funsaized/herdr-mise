import type {
  AgentMachine,
  AgentStore,
  Scheduler,
  Settings,
  StoreSnapshot,
} from "../state/store";
import { tokens } from "../theme/tokens";
import {
  StateAnnouncementController,
  type AttentionCandidate,
  type AttentionStage,
} from "./state-announcements";

const favicon = (blocked: boolean) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="${tokens.chrome.panel}"/><path d="M14 42h36v8H14zm6-28h24v8H20zm-6 14h36v8H14z" fill="${tokens.chrome.text}"/>${blocked ? `<path d="M32 7v25m0 9v5" stroke="${tokens.semantic.flame}" stroke-width="7"/>` : ""}</svg>`)}`;

type Episode = {
  boundary: unknown;
  startedAt: number;
  enteredAt: number;
  stage: number;
};
const stages: readonly AttentionStage[] = ["enter", "fast", "vignette"];
const live = (snapshot: StoreSnapshot) =>
  snapshot.feedMode === "live" &&
  (snapshot.mode === "live" || snapshot.mode === "empty") &&
  snapshot.sourceStatus === "connected";
const knownBlocked = (agent: AgentMachine) =>
  agent.targetState === "blocked" && agent.stateKnown !== false;

export class OffscreenAttentionController {
  private episodes = new Map<string, Episode>();
  private connected = false;
  private timer: unknown = null;
  private owned: Notification | null = null;
  private unsubscribe: () => void;
  private originalTitle = document.title;
  private icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  private originalIcon = this.icon?.getAttribute("href") ?? null;
  private createdIcon = false;
  private priorSettings: Settings;
  private priorHidden = document.hidden;
  private priorEligible = false;

  constructor(
    private store: AgentStore,
    private announcements: StateAnnouncementController,
    private scheduler: Scheduler = {
      now: Date.now,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    },
    private onDeliveryFailure: (failed: boolean) => void = () => {},
  ) {
    this.priorSettings = store.snapshot().settings;
    if (!this.icon) {
      this.icon = document.createElement("link");
      this.icon.rel = "icon";
      document.head.append(this.icon);
      this.createdIcon = true;
    }
    this.unsubscribe = store.subscribe(() => this.reconcile());
    document.addEventListener("visibilitychange", this.visibility);
    this.reconcile();
  }

  private eligible(snapshot: StoreSnapshot) {
    return (
      document.hidden &&
      live(snapshot) &&
      snapshot.settings.desktopNotifications &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    );
  }

  private close() {
    try {
      this.owned?.close();
    } catch {
      /* Browser endpoint may have gone away. */
    }
    this.owned = null;
  }

  private visibility = () => this.reconcile();

  private reconcile() {
    const snapshot = this.store.snapshot();
    const active = live(snapshot);
    const count = active
      ? [...snapshot.agents.values()].filter(knownBlocked).length
      : 0;
    document.title = !active
      ? snapshot.mode === "demo"
        ? "DEMO SERVICE — herdr-mise"
        : snapshot.mode === "connecting"
          ? "Connecting — herdr-mise"
          : "Disconnected — herdr-mise"
      : count
        ? `(${count} blocked) herdr-mise`
        : this.originalTitle;
    this.icon?.setAttribute(
      "href",
      count ? favicon(true) : (this.originalIcon ?? favicon(false)),
    );

    const settings = snapshot.settings;
    const eligible = this.eligible(snapshot);
    const rebase =
      !this.connected ||
      !active ||
      this.priorHidden !== document.hidden ||
      !eligible ||
      !this.priorEligible ||
      this.priorSettings.desktopNotifications !==
        settings.desktopNotifications ||
      this.priorSettings.escalationFastMs !== settings.escalationFastMs ||
      this.priorSettings.escalationVignetteMs !== settings.escalationVignetteMs;
    this.priorHidden = document.hidden;
    this.priorEligible = eligible;
    this.priorSettings = settings;
    if (rebase) {
      this.announcements.cancelDesktop();
      this.close();
    }
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    if (!active) {
      this.connected = false;
      this.episodes.clear();
      return;
    }
    const now = this.scheduler.now();
    for (const id of this.episodes.keys())
      if (!snapshot.agents.has(id) || !knownBlocked(snapshot.agents.get(id)!))
        this.episodes.delete(id);
    for (const agent of snapshot.agents.values()) {
      if (!knownBlocked(agent)) continue;
      const boundary = agent.history.at(-1);
      const startedAt = boundary?.startedAt ?? agent.transitionStartedAt;
      const enteredAt = startedAt;
      const reached =
        now - enteredAt >= settings.escalationVignetteMs
          ? 2
          : now - enteredAt >= settings.escalationFastMs
            ? 1
            : 0;
      let episode = this.episodes.get(agent.id);
      if (
        !episode ||
        episode.boundary !== boundary ||
        episode.startedAt !== startedAt
      ) {
        episode = {
          boundary,
          startedAt,
          enteredAt,
          stage: rebase ? reached : -1,
        };
        this.episodes.set(agent.id, episode);
      }
      if (rebase) episode.stage = reached;
      else if (reached > episode.stage) {
        episode.stage = reached;
        this.announcements.enqueue({
          agentId: agent.id,
          episode: [boundary, startedAt],
          stage: stages[reached]!,
          eligible: this.eligible(snapshot),
        });
      }
    }
    this.connected = true;
    if (eligible) {
      let delay = Infinity;
      for (const episode of this.episodes.values()) {
        if (episode.stage < 1)
          delay = Math.min(
            delay,
            episode.enteredAt + settings.escalationFastMs - now,
          );
        if (episode.stage < 2)
          delay = Math.min(
            delay,
            episode.enteredAt + settings.escalationVignetteMs - now,
          );
      }
      if (Number.isFinite(delay))
        this.timer = this.scheduler.setTimeout(
          () => {
            this.timer = null;
            this.reconcile();
          },
          Math.max(0, delay),
        );
    }
  }

  deliver = (candidates: readonly AttentionCandidate[]) => {
    const snapshot = this.store.snapshot();
    if (!this.eligible(snapshot)) return;
    const valid = candidates.filter((candidate) => {
      const agent = snapshot.agents.get(candidate.agentId);
      const episode = this.episodes.get(candidate.agentId);
      return (
        candidate.eligible &&
        agent &&
        knownBlocked(agent) &&
        episode &&
        episode.boundary === candidate.episode[0] &&
        episode.startedAt === candidate.episode[1] &&
        episode.stage >= stages.indexOf(candidate.stage)
      );
    });
    if (
      !valid.length ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    const stage = Math.max(
      ...valid.map((candidate) => stages.indexOf(candidate.stage)),
    );
    const body = `${valid.length} blocked agent${valid.length === 1 ? "" : "s"}${stage === 2 ? " need attention (screen-edge escalation)" : stage === 1 ? " need attention (escalated)" : " need attention"}. Open the page to review.`;
    try {
      this.close();
      this.owned = new Notification("herdr-mise", {
        body,
        tag: "herdr-mise-blocked",
        silent: true,
      });
      this.onDeliveryFailure(false);
    } catch {
      this.owned = null;
      this.onDeliveryFailure(true);
    }
  };

  destroy() {
    this.unsubscribe();
    document.removeEventListener("visibilitychange", this.visibility);
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.announcements.cancelDesktop();
    this.close();
    document.title = this.originalTitle;
    if (this.createdIcon) this.icon?.remove();
    else if (this.originalIcon === null) this.icon?.removeAttribute("href");
    else this.icon?.setAttribute("href", this.originalIcon);
  }
}
