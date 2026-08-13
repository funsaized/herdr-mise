# herdr-mise — TUI plugin implementation plan

Goal: make herdr-mise a true herdr plugin. The binary gains a terminal
renderer that herdr launches inside a split pane (the herdr-flock model),
**in addition to** the existing localhost browser app. Phase 1 delivers a
functioning plugin with a status-table view; Phase 2 delivers the kitchen
scene as terminal cell art.

Grounding references:

- Plugin contract: [ragamo/herdr-flock](https://github.com/ragamo/herdr-flock)
  — `herdr-plugin.toml` with `[[panes]]` (herdr runs the pane `command` in a
  pty; the process's TUI _is_ the pane) and `[[actions]]`
  (`herdr plugin pane open --plugin <id> --entrypoint <pane>`). Requires
  herdr 0.7.0+, a Unicode + 256-color terminal, linux/macos.
- This repo's seams: `Feed::subscribe() -> broadcast::Receiver<AgentStateEvent>`,
  `Feed::snapshot()`, `Feed::subscribe_health()` (`server/src/feed.rs:90-107`);
  the shared protocol types in `server/src/protocol.rs`; golden fixtures in
  `protocol/fixtures/`.

## Architecture

One binary, two renderers of one feed. The TUI is a second `Feed` subscriber
living next to `axum::serve`; nothing upstream of `Feed` changes.

```
             Herdr unix socket (protocol 17/19)
                          |
                 adapter::Normalizer          (unchanged)
                          |
                        Feed                  (unchanged)
              broadcast<AgentStateEvent>
                 /                  \
        service.rs (axum)      tui/ (new, ratatui)
        /ws + embedded SPA     pane-rendered view
                 |                    |
        Browser @ :8686        herdr split pane
```

Process modes (parsed from `std::env::args()`, no CLI crate):

| Invocation         | Behavior                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `herdr-mise`       | Today's behavior: HTTP server only. Unchanged default.                                                 |
| `herdr-mise --tui` | TUI on the controlling terminal **and** HTTP server concurrently. This is what the pane manifest runs. |

`--tui` rules:

- The HTTP listener failing to bind (another herdr-mise instance already on 8686) must **not** kill the TUI: log one line to the TUI status bar and
  continue TUI-only. Two panes → one wins the port, both render.
- Quitting the TUI (`q` / `Esc`) cancels the shared `CancellationToken`, which
  also shuts down axum — pane close means process exit, matching herdr's
  pane lifecycle.
- On panic, restore the terminal (raw mode off, leave alternate screen) via a
  panic hook installed before entering raw mode. Non-negotiable: a garbled
  herdr session is the worst failure mode a pane plugin can have.

### New code layout

```
server/src/tui/
  mod.rs        entry: terminal setup/teardown, event loop
  state.rs      AgentTable: replays snapshot/delta into ordered Vec<AgentRecord>
  view.rs       Phase 1: pure render fn (table + 86 board + status bar)
  theme.rs      accent palette + per-state colors (ported from client tokens)
  # Phase 2 adds:
  canvas.rs     PixelCanvas widget (half-block ▀ renderer)
  scene/        layout, sprites, particles, composition
herdr-plugin.toml   plugin manifest at repo root
```

### Event loop (mod.rs)

`tokio::select!` over four sources, all already available:

1. `feed.subscribe()` receiver — apply each `AgentStateEvent` to `AgentTable`
   (`Snapshot` replaces, `Delta` upserts/removes, `Heartbeat` ignored). On
   `RecvError::Lagged`, recover with `feed.snapshot()` — same recovery contract
   the WS client has.
2. `crossterm::event::EventStream` (needs the `event-stream` feature) — keys.
3. `tokio::time::interval` tick (1 Hz Phase 1, ~10 Hz Phase 2) — redraw for
   time-in-state counters / animation.
4. `shutdown.cancelled()`.

### Determinism rule (load-bearing for testing)

All rendering is `view::draw(frame, &AgentTable, now: DateTime<Utc>, tick: u64)`
— a pure function of explicit inputs. No `Utc::now()`, no RNG inside `view.rs`
or `scene/`. The loop samples the clock once per tick and passes it down. This
is what makes ratatui `TestBackend` golden tests deterministic, and it mirrors
how the Pixi scene already reads the store per ticker frame.

## Reuse map

| Existing asset                                                                                                    | How it's used                                                                                           | Work              |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------- |
| `Feed` API (`feed.rs:90-107`)                                                                                     | TUI subscribes exactly like the WS handler                                                              | none              |
| `protocol.rs` types                                                                                               | `AgentTable` stores `AgentRecord` verbatim                                                              | none              |
| `discovery.rs`, `compatibility/herdr.json`                                                                        | already wired through `Feed::start`                                                                     | none              |
| `demo.rs` + Feed demo fallback                                                                                    | no-socket pane shows demo service automatically (flock parity: "falls back to demo mode")               | none              |
| `protocol/fixtures/*.v1.json`                                                                                     | golden inputs for `AgentTable` replay tests                                                             | test glue only    |
| `SourceStatus` / `SourceDiagnostic`                                                                               | status bar text (`GAS LEAK`, `DEMO SERVICE`, waiting copy — reuse `ModeTreatment` wording)              | copy strings      |
| `client/src/theme/tokens.ts` 12-accent palette                                                                    | port hex values to `tui/theme.rs` as `Color::Rgb`; `accent_index: 0..11` already on every `AgentRecord` | ~30 lines         |
| `client/src/scene/geometry.ts` pure helpers (`workspaceDisplayName`, `compactPixelText`, `stationIdentityLabels`) | port to Rust for station labels — small pure string fns with existing TS tests to mirror                | ~60 lines + tests |
| CI (`ci.yml`)                                                                                                     | `cargo fmt/check/test --workspace` already gate everything in `server/src`                              | none              |
| `cargo-audit` job                                                                                                 | vets the two new dependencies                                                                           | none              |

Not reusable, by design: `kitchen-scene.ts` (WebGL immediate-mode draw calls),
`layout.ts` (pixel-unit grid ~10× terminal resolution), Pixi particles. Phase 2
re-draws these as cell art; only the _state semantics_ carry over.

Note: `scripts/audit-pixi-architecture.mjs` scans `client/src` only — the Rust
TUI does not touch it. No audit changes needed in either phase.

## Dependencies (the only new ones)

```toml
# server/Cargo.toml
ratatui = "0.29"
crossterm = { version = "0.28", features = ["event-stream"] }
```

Same pair, same versions as herdr-flock. Both pass `cargo audit` today; the
existing `rust-advisories` CI job gates regressions.

---

## Phase 1 — functioning plugin, status view

### Deliverables

1. **`--tui` mode** in `main.rs`: spawn axum as a task (bind failure downgraded
   to a status-bar warning in TUI mode), run the TUI event loop on the main
   task, shared `CancellationToken`.
2. **`tui/state.rs` — `AgentTable`**: ordered agent map replaying
   `AgentStateEvent` (the Rust twin of `client/src/state/store.ts`'s reducer),
   plus a ring of the last 3 `ended` records for the 86 board.
3. **`tui/view.rs` — status view**:
   - Header: `MISE — LIVE|DEMO SERVICE` + source-status line (reuse
     `ModeTreatment` copy: waiting / gas-leak / demo placard).
   - Agent table: name (accent color), state (semantic color, blocked rows
     highlighted), time-in-state (from `state_entered_at` vs injected `now`),
     model, workspace label (via ported `workspaceDisplayName`), tickets,
     runtime.
   - 86 board: last 3 ended sessions as chalk rows (`NAME … 12M 4`).
   - Footer: keys (`q` quit).
4. **`herdr-plugin.toml`** at repo root:

   ```toml
   id = "mise.kitchen"
   name = "Mise"
   version = "0.1.0"
   min_herdr_version = "0.7.0"
   description = "Your coding agents as line cooks — kitchen status in a pane"
   platforms = ["linux", "macos"]

   [[build]]
   command = ["cargo", "build", "--release"]
   platforms = ["linux", "macos"]

   [[panes]]
   id = "kitchen"
   title = "Mise Kitchen"
   placement = "split"
   command = ["./target/release/herdr-mise", "--tui"]

   [[actions]]
   id = "open"
   title = "Open Mise Kitchen"
   contexts = ["workspace"]
   command = ["sh", "-c", "$HERDR_BIN_PATH plugin pane open --plugin mise.kitchen --entrypoint kitchen --placement split --direction right --focus"]
   ```

   Known trade-off: `cargo build --release` alone embeds the fallback assets,
   not the Vite bundle, so a from-manifest install serves the degraded browser
   page until `npm run build` has run. Acceptable for Phase 1 (the pane is the
   product here); revisit the build command when publishing to the marketplace.

5. **Docs**: README "As a herdr plugin" section (install via
   `herdr plugin link .`, keybinding snippet, standalone `--tui` demo mode) and
   an `architecture.md` update adding the TUI branch to the layered diagram.

### Checks (automated)

- `AgentTable` unit tests replaying every file in `protocol/fixtures/`
  (snapshot → delta-upsert → delta-remove → heartbeat) asserting final table
  contents and 86-board ordering. Fixtures are the shared source of truth —
  same ones `protocol.rs` round-trips.
- Ratatui `TestBackend` golden tests: render `view::draw` at fixed `now`/size
  for (a) demo snapshot, (b) live with one blocked agent, (c) empty/waiting,
  (d) unsupported-protocol diagnostic; assert against committed buffer dumps.
- Integration test: `Feed::fixed(...)` + injected events → `AgentTable` via the
  real loop-apply path (no pty needed; the loop's apply step is a plain fn).
- Manifest test (Rust, `toml` as dev-dependency): parse `herdr-plugin.toml`,
  assert pane command binary == the `[[bin]]` name, action references
  `id.pane`, `min_herdr_version` present.
- Existing CI rides along: `cargo fmt --check`, `cargo check`, and
  `cargo test --workspace` (both fallback-asset and production-asset
  invocations), plus `cargo audit`.

### Gates (exit criteria for Phase 1)

- [ ] Building, linking (`herdr plugin link .`), and opening the pane
      (the `[[actions]]` open command) shows live agents in a split pane;
      states transition without restart.
- [ ] Same command with no herdr socket shows the demo service (flock parity).
- [ ] Browser at `:8686` works simultaneously with the pane open.
- [ ] Second pane instance (port taken) still renders, with the warning.
- [ ] `q` closes the pane cleanly; `kill -9` of a paused pane does not leave
      the enclosing terminal in raw mode (panic-hook check: `cargo test` has a
      test asserting the hook is installed; the raw-mode check is manual).
- [ ] CI green with zero changes to `client/` and zero changes to existing
      scripts.

---

## Phase 2 — kitchen scene in cells

### Deliverables

1. **`tui/canvas.rs` — `PixelCanvas`**: a ratatui widget over an RGB pixel
   buffer rendered with upper-half-block `▀` (fg = top pixel, bg = bottom
   pixel), doubling vertical resolution. An 80×24 pane becomes a 160-wide
   (80×2-tall→48) pixel grid — enough for flock-style sprites. This widget is
   the single browser-coupling replacement: everything above it draws pixels,
   exactly like `Graphics.rect().fill()` chains today, just at cell scale.
   - Color: `Color::Rgb` primary; a one-shot downmap to the xterm-256 cube
     when `COLORTERM` lacks `truecolor` (pure fn, unit-tested).
2. **`tui/scene/layout.rs`**: station grid reflow by agent count within the
   pane's pixel dimensions, min-size floor (below it, render the Phase 1 table
   instead — the fallback ships free because Phase 1 keeps `view.rs`).
3. **`tui/scene/sprites.rs`**: cook poses as `const` pixel bitmaps, 4–6 px
   tall — original art, one pose set per state:
   | State   | Scene beat (parity with `kitchen-scene.ts`)              |
   | ------- | -------------------------------------------------------- |
   | idle    | cook at station, 2-frame chop/wipe loop                  |
   | working | flame under pan + steam particles, accent-colored ticket |
   | blocked | cook at the pass, red ring pulse, elapsed chip           |
   | done    | plate under lamps, dimmed ticket                         |
   | ended   | exits; chalk row appended to 86 board                    |
4. **`tui/scene/particles.rs`**: pooled steam (fixed-size array, index-seeded —
   no RNG, per the determinism rule).
5. **`tui/scene/mod.rs`**: composition — room, pass, 86 board, per-station
   cook + ticket + labels (reusing the ported `geometry` helpers and
   `theme.rs` palette), escalation treatment (edge vignette ≈ border color
   shift) for long-blocked agents using the existing threshold semantics.
6. Tick rate raised to ~10 Hz behind the same loop; `view.rs` table remains as
   the small-pane and `--tui` degraded-terminal fallback.
7. **Parity checklist** committed as `docs/tui-scene-parity.md`: every visual
   in the browser scene → its TUI treatment → done/deferred. Deferring is
   fine; undocumented gaps are not.
8. **README media**: a demo GIF of the pane (record with `vhs` tape checked
   into `scripts/`, mirroring the existing `capture-readme-media.mjs`
   pattern for the browser).

### Checks (automated)

- `PixelCanvas` unit tests: pixel→cell mapping (odd heights, clipping,
  fg/bg pairing), truecolor→256 downmap.
- Golden `TestBackend` scene renders at fixed `(now, tick, size)` for each
  state and for the min-size fallback — committed buffer dumps, same harness
  as Phase 1.
- Animation determinism test: two runs of 100 ticks over the same event
  sequence produce identical buffers.
- Frame-budget check: bench-style test asserting a full scene render at 20
  agents (the demo roster ×4) stays under 5 ms on CI hardware; fail = a
  drawing loop went quadratic. (`ponytail:` coarse wall-clock assert, swap
  for criterion if it flakes.)
- Layout property test: for pane sizes 40×10 → 300×80 and 0–20 agents, no
  sprite overlaps and everything stays in-bounds (plain loops, no proptest
  dependency).

### Gates (exit criteria for Phase 2)

- [ ] Side-by-side parity review against the browser scene using the same
      demo feed: every row in `tui-scene-parity.md` marked done or
      explicitly deferred with a reason.
- [ ] Pane is legible and stable at 80×24, degrades to the table below
      min-size, and handles live resize without artifacts.
- [ ] Blocked escalation visible within one tick of the state change
      (the pane's whole job is glanceability).
- [ ] 30-minute soak against a real herdr session (reuse the
      `acceptance-soak.sh` pattern): no panic, no terminal corruption, RSS
      stable.
- [ ] CI green; still zero changes under `client/`.

## Sequencing and risks

Phase 1 is ~1 day of work and independently shippable; link it into a real
herdr session before starting Phase 2 — the pane lifecycle, pty behavior, and
socket discovery assumptions all get validated by the cheap version first.
Phase 2 is 1–2 weeks, dominated by sprite art and scene composition
(herdr-flock's entire `src/` is the reference scale).

Risks:

- **Herdr plugin contract is observed, not documented** — the manifest schema
  is reverse-engineered from herdr-flock. Mitigation: the manifest test pins
  our assumptions; validate against `herdr plugin link` on day one of Phase 1.
- **Pane pty environment** — herdr may not propagate `COLORTERM`/`TERM` as the
  user's shell does. Mitigation: the 256-color downmap and the table fallback
  are both in the plan, not afterthoughts.
- **Feed broadcast lag under bursty sessions** — already handled by the
  `Lagged`→`snapshot()` recovery step; the integration test covers it.
