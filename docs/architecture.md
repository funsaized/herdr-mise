# herdr-mise — architecture

This document describes how herdr-mise actually wires together. It is
grounded in source: the Rust server under `server/src/`, the
TypeScript client under `client/src/`, and the shared protocol under
`protocol/`.

## Layered model

```
                +--------------------------+
                |  Browser (localhost only)|
                |  http://127.0.0.1:8686   |
                +------------+-------------+
                             |
                             |  HTTP (embedded SPA + assets)
                             |  WebSocket /ws (snapshot, deltas, heartbeat)
                             v
                +--------------------------+
                |  herdr-mise (single Rust |
                |  binary, axum + tokio)   |
                +------------+-------------+
                             |
                             |  Unix socket (newline-delimited JSON)
                             |  Herdr protocol 17 or 19
                             v
                +--------------------------+
                |  Herdr ecosystem         |
                |  (herdr daemon / sessions|
                |   on the user's machine) |
                +--------------------------+
```

The release artifact is one binary. The Rust server embeds and serves the
client files via `rust-embed`, while the client executes separately in the
browser. The same `axum::Router` serves those static assets and owns the
WebSocket (`server/src/service.rs`, `server/Cargo.toml`).

### Phase 1 — concurrent browser and TUI renderers

Phase 1 adds a second `Feed` subscriber inside the same Rust binary: a
ratatui-based TUI that Herdr runs inside a managed pty as a split
pane. Both renderers read from the same `Feed` broadcast; the
adapter, the Feed itself, and the protocol types are unchanged from
the browser-only path (`server/src/main.rs`, `server/src/runtime.rs`,
`server/src/feed.rs`).

```
                +--------------------------+
                |  Herdr ecosystem         |
                |  (herdr daemon / sessions|
                |   on the user's machine) |
                +-----------+--------------+
                            |
                            |  Unix socket
                            |  (newline-delimited JSON,
                            |   Herdr protocol 17 or 19)
                            v
                  +---------+----------+
                  |  adapter::         |
                  |  Normalizer        |
                  |  (unchanged)       |
                  +---------+----------+
                            |
                            v
                  +---------+----------+
                  |  Feed              |
                  |  broadcast<       |
                  |  AgentStateEvent>  |
                  +---------+----------+
                            |
              +-------------+-------------+
              |                           |
              v                           v
     +--------+---------+        +--------+---------+
     |  axum HTTP + WS  |        |  ratatui TUI     |
     |  browser         |        |  pane            |
     |  127.0.0.1:8686  |        |  in herdr pty    |
     +------------------+        +------------------+
              |                           |
              v                           v
   Browser @ 127.0.0.1:8686      Herdr split pane

   shared CancellationToken:
   - main.rs / runtime.rs create one token before either task starts.
   - server::serve_http uses shutdown.cancelled_owned() to stop axum.
   - tui::run selects on shutdown.cancelled() and exits on q / Esc.
   - either path cancelling the token also reaps the other branch.
```

Process modes (parsed in `server/src/runtime.rs`; no CLI crate):

| Invocation         | Behavior                                                                           |
| ------------------ | ---------------------------------------------------------------------------------- |
| `herdr-mise`       | HTTP server only. Default; unchanged.                                              |
| `herdr-mise --tui` | TUI on the controlling terminal **and** HTTP server concurrently. What Herdr runs. |

`--tui` rules:

- HTTP bind failure (another herdr-mise already on `127.0.0.1:8686`) is
  downgraded to a single status-bar line; the TUI keeps rendering.
  The two panes render in parallel; the port winner is arbitrary.
- `q` / `Esc` cancel the shared `CancellationToken`, which also
  shuts down axum — pane close means process exit, matching Herdr's
  pane lifecycle.
- A panic hook installed before entering raw mode restores the
  terminal (raw mode off, alternate screen left) so a crashing pane
  never garbles the enclosing Herdr session.
- Rendering is `view::draw(frame, &AgentTable, warning: Option<&str>, now: DateTime<Utc>, tick: u64)`
  — pure of explicit inputs. No `Utc::now()` or RNG inside `view.rs`
  or `theme.rs`; the loop samples the clock once per tick. This is
  what makes the four committed `TestBackend` goldens deterministic.

When Herdr links the repo as a plugin (`herdr-plugin.toml` at the repo
root, contract-pinned by the `plugin_manifest_contract` test), it
spawns `./target/release/herdr-mise --tui` in a split pane and the
TUI shown there is the same process whose browser app is reachable at
`http://127.0.0.1:8686`.

## Concrete components

```
  +----------------------------------------------------------------+
  |  Browser process                                                |
  |                                                                |
  |   +-------------------+      +----------------------------+    |
  |   |  React (chrome)   |      |  PixiJS scene (canvas)     |    |
  |   |  App.tsx          |      |  kitchen-scene.ts          |    |
  |   |  Chrome.tsx       |      |  layout.ts                 |    |
  |   |  (mounts in       |      |  particles.ts              |    |
  |   |   cssLayer, not   |      |  transition.ts             |    |
  |   |   in per-frame)   |      |  (Ticker: stopped while    |    |
  |   |                   |      |   hidden or disconnected)  |    |
  |   |  Subscribes to    |      |                            |    |
  |   |  coarse slices    |      |                            |    |
  |   |  only             |      |  Reads from store inside   |    |
  |   |                   |      |  the ticker (per-frame     |    |
  |   |                   |      |  values bypass React)      |    |
  |   +---------+---------+      +-------------+--------------+    |
  |             |                              |                   |
  |             +-------------+----------------+                   |
  |                           v                                    |
  |               +----------------------+                        |
  |               |  AgentStore (plain    |                        |
  |               |  TS, no React)        |                        |
  |               |  - per-agent machines |                        |
  |               |  - settings           |                        |
  |               |  - 86 board (FIFO 50) |                        |
  |               |  - done timers        |                        |
  |               +----------+-----------+                        |
  |                          |                                    |
  |                          v                                    |
  |               +----------------------+                        |
  |               |  AgentWebSocketClient |                        |
  |               |  - snapshot first     |                        |
  |               |  - deltas after       |                        |
  |               |  - 1 Hz heartbeat     |                        |
  |               |    liveness only      |                        |
  |               |  - 2.9 s silence ->   |                        |
  |               |    disconnected       |                        |
  |               |  - 1 s reconnect,     |                        |
  |               |    resync on next     |                        |
  |               |    open               |                        |
  |               +----------------------+                        |
  +----------------------------------------------------------------+
                              |
                              v
  +----------------------------------------------------------------+
  |  herdr-mise server process (Rust)                              |
  |                                                                |
  |   main.rs        tokio::main, binds 127.0.0.1:8686, axum srv  |
  |   discovery.rs   HERDR_SOCKET_PATH > XDG > HOME > ./.config    |
  |   feed.rs        Atomic mode/status/roster, startup retry,     |
  |                  Live/Demo, 1.25 s coalescer                   |
  |   adapter.rs     Herdr protocol normalizer (schema kept       |
  |                  here), snapshot+delta on internal bus         |
  |   demo.rs        Deterministic six-agent roster: Codex cycles, |
  |                  Claude stays blocked, Gemini ends every      |
  |                  5 min                                        |
  |   service.rs     axum::Router:                                 |
  |                    GET /ws -> WS upgrade, Origin allowlist,    |
  |                     snapshot, deltas, 1 Hz heartbeat,          |
  |                     lagged-resync                              |
  |                    * -> static_asset (rust-embed, SPA          |
  |                     fallback limited to nav-like paths)        |
  |   protocol.rs    Versioned AgentStateEvent (snapshot|upsert   |
  |                  |remove|heartbeat)                            |
  +----------------------------------------------------------------+
                              |
                              v
  +----------------------------------------------------------------+
  |  Herdr daemon (out of process, on the user's machine)           |
  |  - session.snapshot                                             |
  |  - events.subscribe (unfiltered structural pane/tab/workspace    |
  |                       events; status comes from snapshots)       |
  |  - newline-delimited JSON over the discovered Unix socket       |
  +----------------------------------------------------------------+
```

## Browser to embedded server to Herdr adapter

```
  Browser                                                Server
  ------                                                ------

  AgentWebSocketClient.open() -----TCP WS upgrade-----> service::ws
                                                         |
                                                         |  checks Origin
                                                         |    (loopback / missing)
                                                         v
                                                     service::client
                                                         |
                                                         |  Feed::snapshot
                                                         |   -> serialized
                                                         v
  <-Text "snapshot"---------------------------------   WS frame
  ... parsed by AgentStore.apply ...

  Loop thereafter (one tick at a time):

  feed changes  ----broadcast::Receiver event---->  service::client
                                                         |
                                                         |  text-serialize
                                                         v
  <-Text "delta" (or "heartbeat")------------------   WS frame
```

Two correctness rules enforced end-to-end:

- **Snapshot before delta.** The first frame on a new WebSocket is
  always a full snapshot; deltas follow
  (`server/src/service.rs`, `server/src/feed.rs`).
- **Snapshot before delta at the store.** `client/src/state/store.ts`
  keys the whole UI off `apply()`, and a reconnecting client always
  receives a fresh snapshot on `open`, not deltas relative to its
  previous session.

## Demo fallback and automatic recovery

```
  Feed::start -> install labeled demo roster -> spawn startup recovery
                                                |
                         fetch + normalize fresh snapshot
                                                |
              failure --------------------------+----------- success
                 |                                             |
       publish typed sourceStatus                    one FeedState write:
       wait 250ms..4s, retry                         mode + connected + roster
                 |                                             |
                 +---------------- retry              broadcast full snapshot
```

Demo content is deterministic at the process level: a fixed run start
timestamp, dwell measured in tens of seconds or minutes (not one-second
churn), Codex repeating working → blocked → working → done with a stable
id, Claude parked in `blocked`, and Gemini ending once per five-minute
session before returning with a new id. The roster is always labeled
`"mode": "demo"` and carries a typed, non-sensitive `sourceStatus` in the
snapshot. The chrome renders the persistent
_DEMO SERVICE_ placard (`server/src/demo.rs`,
`client/src/chrome/Chrome.tsx`).

`FeedState` keeps mode, source status, and agents under one write lock. Recovery
normalizes before acquiring that lock, replaces the complete roster, and then
broadcasts a live snapshot. Source-loss recovery follows the same
fresh-snapshot-first installation before health is restored, preserving the
WebSocket snapshot-before-delta contract.

## Typed heartbeat and liveness

```
  service::client                                        Browser
  ----------------                                       -------
  tokio::time::interval(1s) ----------Text "heartbeat"--> AgentWebSocketClient
                                                          onmessage
                                                          |  parsed.type === "heartbeat"
                                                          v
                                                        armStale()  // 2.9 s
                                                          (store NOT mutated,
                                                           lastUpdateAt unchanged)
```

The server emits a typed `AgentStateEvent::Heartbeat` once per second
on every connected WebSocket. The client treats it as liveness only;
it does not apply it to the `AgentStore`. This is what stops the
"quiet live feed -> disconnect flapping" defect that would otherwise
re-trigger the disconnected overlay on a kitchen where nothing was
happening.

The client still surfaces `disconnected` after a 2.9 s silence — that
is the agreed liveness budget for genuinely stale data — and
reconnects in 1 s.

## Coalescing of bursty production events

```
  Herdr event wake --+
                     |
                     v
  run_live::interval(1s)
      |
      |--- adapter::fetch_snapshot (2 s bound)
      |--- normalize_snapshot_value
      |--- apply_live_coalesced(active_agents, ended_ids)
                |
                v
          pending: HashMap<id, AgentRecord>
                |
                v
  run_coalescer (1.25 s) ----drain pending----> reconcile(active, authoritative=false)
                |                                       |
                |                                       v
                |                                 broadcast -> WS frame
                v
        (runs for the process lifetime; process exit reaps it)
```

`publish_high_frequency` is the production path for bursty
publication. Anything that goes through it lands in `pending` and is
drained by the 1.25 s coalescer task (`server/src/feed.rs`). This is
stricter than the per-agent ≤ 4 Hz release ceiling, and the test
`twelve_record_chatty_source_stays_below_wire_budget` enforces
the ≤ 5 KB/s wire rate with the heartbeat included.

`ended_ids` is the one exception: it always publishes immediately so
the final record of a session is never lost.

## Ended lifecycle

```
  AgentRecord.state = "ended"   (or pane.exited, normalizer infers)
      |
      v
  feed::end_ids
      |   (one final upsert with state = Ended, state_entered_at = now)
      v
  AgentStore.end(agent)
      |
      |  - dedup by id (one BoardEntry per agent id)
      |  - BoardEntry.finalState = prior.targetState (truthful final state)
      |  - FIFO cap at 50, oldest evicted
      v
  emitEvent("ended", entry)
      |
      v
  Chrome.SessionSummary
  (truthful final state, no fabricated history)
```

`server/src/feed.rs` evicts the agent from the live map at the same
time it emits the final upsert, so a reconnecting client never sees
ended agents in its snapshot. The client `end()` keeps board dedup
defensive and stores the truthful final state, which is what
`SessionSummary` renders.

## React and PixiJS ownership

```
  +-----------------------------+        +-------------------------------+
  | React (chrome)              |        | PixiJS (scene)                |
  |                             |        |                               |
  | - Tooltip                   |        | - Room (wall, wainscot,       |
  | - DetailCard                |        |   window, 86 board, shelf,    |
  | - SessionSummary            |        |   back door, pass)            |
  | - SettingsPanel             |        | - Stations (cook, ticket,     |
  | - ModeTreatment (empty,     |        |   label, timer, selection)    |
  |   demo, disconnected)       |        | - Steam particles (pooled)    |
  | - StatsOverlay              |        | - Escalation (bell glow,      |
  | - First-run hint            |        |   screen-edge vignette)       |
  | - Semantic station controls |        |                               |
  | - Live state announcements  |        | One ticker. One canvas.       |
  |                             |        | Reads from AgentStore inside |
  | Reads coarse slices only:   |        | the ticker. Per-frame values |
  |   - count, blocked, done,   |        | bypass React.                 |
  |   - mode, selectedId,       |        |                               |
  |   - settings                |        |                               |
  +--------------+--------------+        +---------------+---------------+
                 |                                       |
                 +------------------+--------------------+
                                    v
                          AgentStore (browser projection owner)
                          + AgentWebSocketClient
```

`AgentStore` is not the upstream source of truth. Herdr's current snapshot owns
live agent truth; `Feed` owns the normalized server projection; `AgentStore` owns
the browser projection plus local selection, settings, observed history, done
timers, and the 86 board. Within an agent machine, `targetState` is feed truth and
`renderedState` is only an interruptible animation projection. The WebSocket client
will not apply deltas until that connection has received a fresh snapshot.

`scripts/audit-pixi-architecture.mjs` enforces the boundary in CI by
forbidding direct WebGL, custom renderer, or shader imports in the
client and requiring that the scene only references native Pixi
classes (`Application`, `Container`, `Graphics`, `Text`) and the
embedded-bundle option.

## Trust and security boundaries

```
  +---------------------------------+  trust: anyone on the same
  |  arbitrary remote webpage       |  machine / VPN (zero)
  +---------------------------------+
        |  (loopback-only protection)
        v
  +---------------------------------+  trust: any same-origin browser
  |  http://localhost:8686 (or      |  and CLI/test clients
  |  http://127.0.0.1:8686)         |  (Origin allowlist)
  +---------------------------------+
        |  WS, snapshot + deltas + heartbeat
        v
  +---------------------------------+  trust: only this process
  |  herdr-mise server (Rust)       |  holds the WS endpoint and the
  |  - 127.0.0.1:8686 only          |  embedded bundle
  |  - origin allowlist on /ws      |
  |  - rust-embed static assets     |
  +---------------------------------+
        |  Unix socket, newline-delimited JSON
        v
  +---------------------------------+  trust: only the running herdr
  |  Herdr daemon (user's machine)  |  daemon on the user's machine
  +---------------------------------+
```

Three trust boundaries worth keeping in mind:

1. **Loopback binding only.** The TCP listener is hardcoded to
   `127.0.0.1:8686` (`server/src/main.rs`). The WebSocket accepts a
   missing `Origin` for CLI and test clients; from a browser it
   accepts only `http://localhost:8686` or `http://127.0.0.1:8686`.
   Anything else returns HTTP 403
   (`server/src/service.rs` `allowed_origin`).
2. **Server keeps zero kitchen concepts.** The server
   only knows about `idle | working | blocked | done | ended`, a
   `mode: live | demo` flag, and the typed `AgentStateEvent`. The
   kitchen is a presentation theme that lives entirely in the client
   (`server/src/adapter.rs` `Normalizer`).
3. **No secrets in the protocol.** The wire format carries agent
   ids, names, model labels, workspace labels, state, progress,
   session stats, and timestamps only. There is no
   authentication, no key material, and no token in any path. The
   release archives and the running binary do not embed any
   credentials; only the embedded client bundle is in the binary,
   and only the typed `AgentStateEvent` crosses the loopback
   boundary.

Non-localhost deployment hardening would belong in this diagram: a reverse
proxy, mTLS, an upstream auth layer, rate limiting, and tenant isolation. None
of that is implemented; herdr-mise remains a single-user, localhost product.
