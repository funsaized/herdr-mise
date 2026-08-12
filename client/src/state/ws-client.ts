import type { AgentStateEvent } from "../../../protocol/generated/agent-state-event";
import type { AgentStore, Scheduler } from "./store";

export interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;
const browserFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as SocketLike;
const browserScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as number),
};

export class AgentWebSocketClient {
  private socket: SocketLike | null = null;
  private reconnectTimer: unknown = null;
  private staleTimer: unknown = null;
  private stopped = true;
  private generation = 0;
  private bytes: { at: number; count: number }[] = [];
  constructor(
    private url: string,
    private store: AgentStore,
    private factory: SocketFactory = browserFactory,
    private scheduler: Scheduler = browserScheduler,
  ) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
  }
  private connect() {
    // Snapshot eligibility is per connection and resets on every reconnect.
    if (this.stopped) return;
    const generation = ++this.generation;
    const socket = this.factory(this.url);
    let hasSnapshot = false;
    this.socket = socket;
    const lose = () => {
      if (generation !== this.generation || this.stopped) return;
      this.scheduler.clearTimeout(this.staleTimer);
      this.staleTimer = null;
      this.store.setDisconnected();
      if (this.reconnectTimer === null)
        this.reconnectTimer = this.scheduler.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, 1_000);
    };
    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.armStale(lose);
    };
    socket.onmessage = (message) => {
      if (generation !== this.generation) return;
      try {
        const raw = String(message.data);
        this.bytes.push({
          at: this.scheduler.now(),
          count: new TextEncoder().encode(raw).byteLength,
        });
        const parsed = JSON.parse(raw) as AgentStateEvent;
        if (
          parsed.version !== 1 ||
          !["snapshot", "delta", "heartbeat"].includes(parsed.type)
        )
          return;
        if (parsed.type === "snapshot") {
          hasSnapshot = true;
          this.store.apply(parsed);
        } else if (parsed.type === "delta" && hasSnapshot)
          this.store.apply(parsed);
        this.armStale(lose);
      } catch {
        /* malformed feed messages are isolated */
      }
    };
    socket.onerror = socket.onclose = lose;
    this.armStale(() => {
      socket.close();
      lose();
    });
  }
  bytesPerSecond(now = this.scheduler.now()) {
    this.bytes = this.bytes.filter((sample) => now - sample.at <= 1_000);
    return this.bytes.reduce((sum, sample) => sum + sample.count, 0);
  }
  private armStale(onStale: () => void) {
    this.scheduler.clearTimeout(this.staleTimer);
    this.staleTimer = this.scheduler.setTimeout(onStale, 2_900);
  }
  private clearTimers() {
    this.scheduler.clearTimeout(this.reconnectTimer);
    this.scheduler.clearTimeout(this.staleTimer);
    this.reconnectTimer = null;
    this.staleTimer = null;
  }
}
