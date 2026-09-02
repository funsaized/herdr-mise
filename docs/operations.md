# herdr-mise — operations

This document covers running, recovering, verifying, and troubleshooting
herdr-mise. Everything here is grounded in the current source —
nothing is described that the binary or the scripts do not actually do.

## Operational source of truth

Herdr's `session.snapshot` is authoritative for live agent state. Subscription
events only wake a bounded snapshot refresh. The server's `Feed` is the normalized
active-roster projection served to browsers; each WebSocket starts with its current
full snapshot. The client `AgentStore` owns only the browser projection and derived
UI state. Its 86 board, observed history, settings, selection, and done timers are
not Herdr records and do not survive site-data loss.

The architecture and ownership boundaries are documented in
[architecture.md](architecture.md), product behavior in the root
[README](../README.md), contributor gates in [CONTRIBUTING.md](../CONTRIBUTING.md),
and release policy in [releasing.md](releasing.md).

## Local run

### Build and run from source

```sh
# one-time
npm ci
npm ci --prefix client

# every dev session
npm run bundle
HERDR_SOCKET_PATH=/tmp/no-herdr.sock ./target/release/herdr-mise
# open http://127.0.0.1:8686
```

`npm run bundle` chains `npm run build` and
`cargo build --release --bin herdr-mise`. The client `dist/` is
embedded into the binary by `rust-embed` at compile time
(`server/Cargo.toml`, `server/src/service.rs`).

The hosted static demo is a separate visual-mode build:

```sh
npm run build -- --mode visual
```

It writes `client/dist-visual/`, including visual-only social metadata and the
checked-in TUI demo assets. Vercel deploys that directory. The default build
continues to write `client/dist/`, which remains the only rust-embed input.

### Run the release archive

The current public distribution is the GitHub release `v0.1.0`. Matching `v*`
tags are classified as prerelease or stable under the fail-closed process in
[Release operations](releasing.md). Each asset pair is:

```text
herdr-mise-v<VERSION>-<TARGET>.tar.gz
herdr-mise-v<VERSION>-<TARGET>.tar.gz.sha256
```

Targets:

| Platform            | `TARGET`                   |
| ------------------- | -------------------------- |
| macOS Apple Silicon | `aarch64-apple-darwin`     |
| macOS Intel         | `x86_64-apple-darwin`      |
| Linux x86_64        | `x86_64-unknown-linux-gnu` |

Download, verify, extract, and run from the upstream release:

```sh
TAG=v0.1.0
TARGET=aarch64-apple-darwin   # or x86_64-apple-darwin / x86_64-unknown-linux-gnu
BASE=herdr-mise-${TAG}-${TARGET}
URL=https://github.com/funsaized/herdr-mise/releases/download/${TAG}

curl -fsSL -O "$URL/$BASE.tar.gz" -O "$URL/$BASE.tar.gz.sha256" \
  && {
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 -c "$BASE.tar.gz.sha256"
    else
      sha256sum -c "$BASE.tar.gz.sha256"
    fi
  } \
  && tar -xzf "$BASE.tar.gz" \
  && ./herdr-mise
# open http://127.0.0.1:8686
```

The default `TARGET` is macOS Apple Silicon. Replace it with either other
target from the table on macOS Intel or Linux x86_64. The checksum selection
uses `shasum` when available (macOS) and `sha256sum` otherwise (Linux). The
explicit `&&` chain prevents checksum verification, extraction, or execution
after any preceding failure; it does not rely on interactive-shell error
handling or exit the user's shell.

The archive contains three top-level files (no nested directory): the
`herdr-mise` executable, the project `LICENSE`, and generated
`THIRD_PARTY_NOTICES.txt` covering the locked production dependency trees and
bundled font licenses. The binary serves the embedded client, opens the
WebSocket, and tails the herdr socket (or runs the demo feed). It binds only to
`127.0.0.1`, on port `8686` by default (`server/src/main.rs`).

### Upgrade and uninstall

There is no installer or package manager entry. Upgrade by stopping the
process, verifying a newer archive's checksum, extracting it, and replacing
the old binary. Uninstall by stopping the process and deleting the binary
(and any leftover archives). Browser settings under
`localStorage["herdr-mise:settings"]` and the `mise-bell-hint` key are
optional cleanup.

## Client development

There are two ways to iterate on the client. The visual playground
is the default: it needs no Rust server, no socket discovery, and
no protocol plumbing. The full build is reserved for integration,
live, and demo testing against the Rust binary.

### Visual playground

```sh
# from the repo root
npm ci
npm ci --prefix client
npm run dev:visual
# open http://localhost:8686
```

`npm run dev:visual` runs `vite --mode visual` against the client.
On boot, `client/src/main.tsx` calls `initializeVisualMode("visual", …)`
before React mounts. That installs a deterministic in-browser
WebSocket mock by replacing `window.WebSocket` for the application
`/ws` endpoint only. During local development, the native constructor is
preserved and delegated for every other URL, including Vite HMR. In a visual
production build, every socket except same-origin `/ws` is refused without
calling the native constructor. The real `AgentWebSocketClient` still opens
`/ws` against the live origin; the mock simply answers on the
client side. Source: `client/src/main.tsx`,
`client/src/runtime.ts`, `client/src/visual-harness.ts`.

#### Query contract

| Parameter | Accepted values                              | Default | Notes                                                                     |
| --------- | -------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| `preset`  | `idle\|working\|blocked\|done\|ended\|mixed` | `mixed` | Any other value falls back to `mixed`.                                    |
| `agents`  | Integer from `1` through `12`                | `6`     | Absent, non-integer, non-finite, or out-of-range values fall back to `6`. |
| `theme`   | `light\|dinner`                              | `light` | `dinner` selects the existing dark lighting.                              |

Parsing and validation are concentrated in
`parseVisualConfig` (`client/src/visual-harness.ts`); both the
client and the test suite prove the defaults and fallbacks.

#### Examples

```text
?preset=done&agents=2
  Two plated cooks with a gray ticket-spike. White kitchen, full motion.

?preset=blocked&agents=12&theme=dinner
  Full 12-station kitchen at the pass, dim lighting, blocked
  red-ring arcs in motion. Each blocked cook is anchored
  45 seconds into the blocked state (below the 60-second first
  escalation threshold), so the blocked treatment is visible
  but not yet escalated.

?preset=ended&agents=6
  Six cooks immediately written to the 86 board. No active
  cooks remain. The board's truthful final state per row is
  `done`, because the harness emits a `done` snapshot first
  and then one `ended` upsert per record through the real
  store boundary — it does not synthesize ended-as-done.
```

#### What each preset draws

- `idle` — prep loops, no ticket; records start 12 seconds into
  the state.
- `working` — flame + steam, white ticket, green edge; records
  start 18 seconds into the state and progress is `(index + 1) / 13`
  per cook.
- `blocked` — red-ring arcs, elapsed timer chip; `stateEnteredAt`
  is `now − 45 s` at feed construction so the scene reads as
  blocked but not yet escalated.
- `done` — plate under lamps, ticket spiked (gray); records start
  8 seconds into the state and use the visible 10-minute default.
- `ended` — cooks leave the kitchen and a row is appended to the
  86 board per record. No active cook is rendered.

#### Isolation guarantees

Visual mode is intentionally isolated from production state:

- **No Rust or herdr contact.** The mock speaks the `AgentStateEvent`
  protocol directly in the browser; the dev server has no awareness
  of the Rust service.
- **No Vite HMR interference.** The WebSocket override only
  intercepts the application `/ws` pathname. Vite's own HMR socket
  and any other `new WebSocket(url)` call delegate to the captured
  native constructor still held in closure.
- **No persisted settings reads or writes.** The visual store is
  constructed with `settingsStorage: null`
  (`client/src/runtime.ts` `createRuntimeStore`), so it never
  reads or writes `localStorage["herdr-mise:settings"]`.
- **No bell-hint persistence.** `createHintPersistence` returns
  `{ isVisible: () => true, dismiss: () => {} }` in visual mode,
  so the dismissed-state key `mise-bell-hint` is never read or
  written. The hint starts visible on each load, can be dismissed
  for the current page session, and returns on reload.
- **No hidden done-timeout override.** Visual mode uses the same
  10-minute value shown in Settings. A plated visual preset therefore
  clears on the documented schedule rather than displaying one value
  while running another.

You can verify these guarantees locally by opening DevTools and
inspecting `localStorage` after exercising presets and dismissing
the hint — nothing under the visual host origin changes.

#### Verification

The focused source-level suite is:

```sh
npm --prefix client run test -- --run src/visual-harness.test.ts
```

The browser acceptance matrix is checked in as `e2e/visual-matrix.spec.ts`
and runs in CI via `npm run test:visual`. It builds `client/dist-visual`, serves
it with `vite preview` on port 4174, and covers every preset and
supported count, the ended 86-board flow, the exact dinner URL,
invalid-query fallback, storage isolation, emitted TUI fixtures, hosted socket
isolation, and liveness beyond the client stale timeout.

After promoting Vercel, run the hosted smoke once:

```sh
HOSTED_VISUAL_URL=https://herdr-mise.s11a.com \
  npm run test:visual -- hosted-smoke.spec.ts
```

This is a client-development harness check, not full-product release
acceptance. Use [CONTRIBUTING.md](../CONTRIBUTING.md#verification-commands) for
the integrated Rust server, source-loss recovery, accessibility, packaging,
and release gates.

### Plain Vite limitations

Plain `npm --prefix client run dev` is **not** a standalone
playground. The client opens `ws[s]://${location.host}/ws`
(`client/src/App.tsx`), and there is no Vite proxy in
`client/vite.config.ts` — by design, since the visual mode is the
documented client-only loop. If you need the full client against
the Rust server without rebuilding the embedded binary, you have
two options:

1. Run the binary (`./target/release/herdr-mise`) and open
   `http://127.0.0.1:8686` — the embedded `dist/` builds and
   serves the same client with a real `/ws` upstream.
2. Stand up your own reverse proxy from the Vite port to
   `127.0.0.1:8686` and add it to `HERDR_MISE_EXTRA_ORIGINS`;
   Vite itself does not proxy `/ws`.

The original "Vite dev server proxies `/ws` to the Rust server"
wording is **not accurate** for this repository and has been
removed.

## Reduced motion and VoiceOver acceptance

Manual VoiceOver listening was explicitly deferred from the v0.1.0 release
gate by the owner on 2026-08-27. The checklist remains `NOT RUN` until someone
actually performs it; this section does not claim a pass.

### Behavior contract

The scene reads the live OS media query
`matchMedia("(prefers-reduced-motion: reduce)")` at startup and subscribes to
its `change` event (`client/src/runtime.ts`,
`client/src/scene/kitchen-scene.ts`). Changing the OS preference updates the
open page in place without a browser reload.

When reduced motion is active, the scene disables these decorative channels:

- idle pose animation and idle marks (`billows` / `zs`);
- steam particles;
- cook bob and working-flame flicker;
- travel and state transitions;
- busser sweep travel; and
- blocked bell-arc pulse and escalation-vignette pulse.

Entering reduced motion also releases active particles, clears transitions,
and removes active busser sweep graphics. The store still reconciles target and
rendered lifecycle state, and the browser continues to update the elapsed
blocked timer text, selection/focus treatment, keyboard controls, and the
polite state-announcement region. Reduced motion changes presentation, not the
truthful feed or the state itself. The CSS fallback also disables the
canvas/filter and toggle-knob transitions and the disconnected-card blink
(`client/src/theme/global.css`).

A blocked cook remains fixed at the pass. The static signal combines a thick
blocked outline, home and pass tickets, an elapsed timer chip, `AT THE PASS`
state text, solid bell arcs, and fixed-opacity escalation vignette geometry when
the corresponding escalation stage is active. The semantic station control
uses an accessible name such as `Codex, Blocked — at the pass, open details`.
The blocked state is therefore communicated with text and shape as well as
color or motion.

### Run setup

Run the local visual candidate from the repository root:

```sh
npm run dev:visual
# open http://localhost:8686/?preset=mixed&agents=6&theme=light
```

The visual harness is deterministic and supports the states needed by this
checklist. Use these local URLs as convenient starting points:

- `?preset=mixed&agents=6&theme=light` — working → blocked → working → done
  announcement and lifecycle sequence;
- `?preset=blocked&agents=1&theme=light` and
  `?preset=blocked&agents=1&theme=dinner` — static blocked signal in both
  themes;
- `?preset=ended&agents=1&theme=light` — 86 board and ended-session summary.

The same checks may be run against a local release binary at
`http://127.0.0.1:8686`. Keep the browser on localhost; this is an acceptance
record for the local, read-only visualizer, not a remote deployment test.

### Acceptance record metadata

Copy this block for each candidate. The placeholders are intentionally blank;
do not replace them with private paths, channel IDs, email addresses, or local
deployment identifiers.

| Field                         | Record                                                                    |
| ----------------------------- | ------------------------------------------------------------------------- |
| Date                          | `<YYYY-MM-DD>`                                                            |
| Commit / candidate identifier | `<commit-or-candidate>`                                                   |
| macOS                         | `<macOS version>`                                                         |
| Browser                       | `<browser and version>`                                                   |
| VoiceOver settings            | `<verbosity, speech rate, punctuation, hints, navigation/rotor settings>` |
| Tester                        | `<tester name or initials>`                                               |
| Overall result                | `NOT RUN`                                                                 |
| Artifact / evidence notes     | `<observed speech transcript, screenshot, recording, or none>`            |

### VoiceOver and keyboard checklist

Every row below intentionally starts at `NOT RUN`. Allowed row values are
`PASS`, `FAIL`, and `NOT RUN`. After a human run, replace that value with
exactly `PASS` or `FAIL` and record the observed VoiceOver speech or other
evidence. Do not infer a manual pass from an automated test or from the
implementation handoff.

#### Roles, names, and status surfaces

| ID    | Action and expected result                                                                                                                                                                                                                                                                | Status    | Observed VoiceOver speech / evidence |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------ |
| VO-01 | Open Settings with the `Open settings` button. VoiceOver exposes a complementary panel named `Settings`, its `Settings` heading, and a `Close settings` button.                                                                                                                           | `NOT RUN` |                                      |
| VO-02 | In Settings, verify a `Service bell` switch exposes its on/off state; `Light`, `Dinner`, and `System` are buttons exposing pressed state; and selects are named `Done timeout`, `Faster bell after`, and `Screen-edge glow after`.                                                        | `NOT RUN` |                                      |
| VO-03 | Navigate the `Agent stations` navigation. Each station control is a button with a name shaped like `<agent>, <state>, open details`; verify the state words are human-readable (`Idle — prepping`, `Working — on the fire`, `Blocked — at the pass`, `Done — plated`, or `Ended — 86'd`). | `NOT RUN` |                                      |
| VO-04 | Activate an agent station control. VoiceOver exposes a complementary panel named `<agent> details`, the agent heading, its state label, a `Close panel` button, and the `Model`, `Workspace`, `Time in state`, `Tickets this session`, and `Session history` text.                        | `NOT RUN` |                                      |
| VO-05 | Open an 86 board row. VoiceOver exposes a complementary panel named `<agent> session summary`, the `86'D — SESSION ENDED` label, a `Close panel` button, and `Mise time`, `Tickets served`, `Ended at`, and `Final state` text.                                                           | `NOT RUN` |                                      |
| VO-06 | When the corresponding condition is present, verify status/alert semantics: `DEMO SERVICE` and `Waiting for agents — start one in herdr` are `status` surfaces; `GAS LEAK — SERVICE SUSPENDED` is an `alert`.                                                                             | `NOT RUN` |                                      |
| VO-07 | Verify the live region is named `Agent state announcements`, is polite, and is atomic. It should expose only the current announcement, not a stale concatenation of prior announcements.                                                                                                  | `NOT RUN` |                                      |

#### Focus, Escape, and restoration

| ID       | Action and expected result                                                                                                                                                                 | Status    | Observed VoiceOver speech / evidence |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------ |
| FOCUS-01 | Activate `Open settings`. Initial focus lands on the `Settings` panel container, not an arbitrary background element.                                                                      | `NOT RUN` |                                      |
| FOCUS-02 | Activate an `Agent stations` button for a live cook. Initial focus lands on the `<agent> details` panel container.                                                                         | `NOT RUN` |                                      |
| FOCUS-03 | Open an ended-session summary. Initial focus lands on the `<agent> session summary` panel container.                                                                                       | `NOT RUN` |                                      |
| FOCUS-04 | With Settings focused, press `Escape`. Settings closes and the page returns to the settings trigger. Repeat with focus on an interactive Settings control to verify Escape remains global. | `NOT RUN` |                                      |
| FOCUS-05 | With an agent detail panel focused, press `Escape`; then repeat with an ended-session summary. The panel closes without changing the Herdr feed.                                           | `NOT RUN` |                                      |
| FOCUS-06 | Open Settings from `Open settings`, close with its close button and with `Escape`, and verify focus returns to the originating `Open settings` trigger each time.                          | `NOT RUN` |                                      |
| FOCUS-07 | Open details by activating the originating semantic station control, close with the panel close button and with `Escape`, and verify focus returns to that same semantic station control.  | `NOT RUN` |                                      |

#### Keyboard operation and announcements

| ID     | Action and expected result                                                                                                                                                                                                                                                     | Status    | Observed VoiceOver speech / evidence |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------ |
| KEY-01 | From the document body, use `ArrowRight`/`ArrowDown` to cycle stations forward and `ArrowLeft`/`ArrowUp` to cycle backward. Use `Tab` from the body as the documented forward cycle. Verify the visible focus ring and station identity change together.                       | `NOT RUN` |                                      |
| KEY-02 | With a station focused, press `Enter` to open details. Verify the station mirror buttons remain `tabindex="-1"` (AX/semantic controls, not ordinary Tab stops) and can still be activated through VoiceOver or the documented keyboard path.                                   | `NOT RUN` |                                      |
| KEY-03 | In Settings and detail/summary panels, use `Tab` and `Shift+Tab` to reach every button, switch, and select. Operate buttons/switches with native keyboard activation, change each select with keyboard input, and use `Escape` to close.                                       | `NOT RUN` |                                      |
| ANN-01 | Cause a real transition into blocked (the initial `blocked` snapshot has no prior state announcement). Expect exactly one concise live-region update with `<agent> blocked, just now`; for other state transitions record the emitted `<agent> <state>` wording.               | `NOT RUN` |                                      |
| ANN-02 | Leave the page open through heartbeats, progress-only updates, and repeated observation of the same state. Expect no duplicate announcement and no stale announcement after the next real state transition. Record any VoiceOver repetition rather than treating it as a pass. | `NOT RUN` |                                      |

#### Reduced-motion startup and runtime changes

| ID    | Action and expected result                                                                                                                                                                                                                                                                                         | Status    | Observed VoiceOver speech / evidence |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------ |
| RM-01 | Set the macOS Reduce Motion preference before opening/reloading the light-theme page. Verify startup is static: no idle pose/mark animation, steam particles, cook bob, flame flicker, travel/transition, busser sweep, or blocked pulse/vignette pulse.                                                           | `NOT RUN` |                                      |
| RM-02 | Repeat RM-01 with the dinner theme. Verify the same motion policy and confirm the blocked signal remains recognizable.                                                                                                                                                                                             | `NOT RUN` |                                      |
| RM-03 | Without reloading the page, change Reduce Motion from reduce to normal. Verify `prefers-reduced-motion` changes in place and adjacent normal-motion channels resume; do not interpret resuming decoration as a state change.                                                                                       | `NOT RUN` |                                      |
| RM-04 | Without reloading, change the preference from normal to reduce. Verify active particles, transitions, busser graphics, and pulses stop/clear immediately and remain static.                                                                                                                                        | `NOT RUN` |                                      |
| RM-05 | While reduced motion is active, let the feed change states. Verify lifecycle labels, the blocked elapsed timer text, keyboard focus/selection, and the live announcement region continue to update.                                                                                                                | `NOT RUN` |                                      |
| RM-06 | In light theme, inspect a blocked cook at the pass. Verify fixed cook-at-pass geometry, high-contrast outline, home/pass tickets, timer chip, `AT THE PASS` text, solid bell arcs, and fixed-opacity vignette at its escalation stage. Confirm the state is conveyed by text and shape, not color or motion alone. | `NOT RUN` |                                      |
| RM-07 | Repeat RM-06 in dinner theme. If the vignette stage is not reached during the session, record that sub-check as `NOT RUN` and include the configured threshold/wait in the evidence notes.                                                                                                                         | `NOT RUN` |                                      |

### Manual result boundary

Record the overall result only after all applicable rows have an explicit
status and evidence note. This document intentionally records no human
VoiceOver result: the initial overall value is `NOT RUN`, and automated checks
such as `npm test`, `npm run audit:accessibility`, and `npm run test:visual` do
not substitute for listening to VoiceOver speech.

## Socket override

`server/src/discovery.rs` resolves the herdr Unix socket in this
order:

1. `HERDR_SOCKET_PATH` (non-empty).
2. `$XDG_CONFIG_HOME/herdr/herdr.sock` (if `XDG_CONFIG_HOME` set).
3. `$HOME/.config/herdr/herdr.sock` (if `HOME` set).
4. `./.config/herdr/herdr.sock` as a final fallback.

Each probe is bounded to 2 s. On failure the server stays in labeled demo mode
and retries with bounded exponential delays of 250 ms, 500 ms, 1 s, 2 s, then
4 s. Shutdown cancels an in-flight probe or delay immediately. Demo snapshots
include a typed `sourceStatus`: `unavailableSocket`, `timeout`,
`unsupportedProtocol`, or `incompatibleResponse`; a live snapshot uses
`connected`. These values contain no payload, agent, workspace, or socket-path
diagnostics.

When Herdr becomes available, the server fetches and normalizes a fresh
snapshot before it atomically changes mode, status, and roster. The same
process and open browser recover without restart. Demo cooks therefore cannot
appear under a live label.

Useful overrides:

```sh
# point at a specific herdr socket
HERDR_SOCKET_PATH=/tmp/herdr.sock ./target/release/herdr-mise

# force demo even when herdr is installed
HERDR_SOCKET_PATH=/tmp/this-socket-does-not-exist.sock ./target/release/herdr-mise

# change demo roster size (default 6, max 12)
HERDR_MISE_DEMO_COUNT=12 ./target/release/herdr-mise

# change the loopback HTTP port (default 8686; 1024-65535)
HERDR_MISE_PORT=9000 ./target/release/herdr-mise
```

## Remote viewing through a personal reverse proxy

The binary always binds to `127.0.0.1`; `HERDR_MISE_PORT` is the only listener
override and changes the port only (default `8686`). By default the `/ws`
endpoint rejects any browser `Origin` other than `http://localhost:<port>` /
`http://127.0.0.1:<port>` for that effective port, so a page
served through a reverse proxy loads but its WebSocket is refused
with HTTP 403 and the client shows _GAS LEAK — SERVICE SUSPENDED_.

`HERDR_MISE_EXTRA_ORIGINS` opts additional exact browser origins into
the `/ws` allowlist for setups like Caddy + Tailscale, where the
proxy — not herdr-mise — owns transport security and access control:

```sh
HERDR_MISE_EXTRA_ORIGINS=https://herdr-mise.example.com \
  ./target/release/herdr-mise
```

Rules and caveats:

- Comma-separated, exact `scheme://host[:port]` matches only. No
  wildcards, no paths. An invalid entry aborts startup with an error
  rather than starting with a policy you did not intend
  (`server/src/service.rs` `parse_extra_origins`).
- The accepted extra origins are printed to stderr at startup so the
  widened policy is always visible.
- The proxy must forward WebSocket upgrades on `/ws` (Caddy's
  `reverse_proxy 127.0.0.1:8686` does this out of the box).
- herdr-mise has no authentication. Everyone who can reach the proxy
  sees your full agent roster, so keep the proxy on a private network
  (e.g. a tailnet) — never on a public interface. herdr-mise does not
  implement non-localhost hardening; the proxy layer is your security boundary.

## Demo fallback

`server/src/demo.rs` produces a deterministic six-cook roster with
realistic dwell times. Codex repeats working → blocked → working → done
with a stable identity, while Claude stays blocked so both escalation
thresholds are reachable; Gemini ends once per five-minute session
and returns with a new session id so the 86 board and the session
summary panel are demonstrable. Time-in-state and per-session ticket
counts update on a five-second quantum so blocked escalation stages
and done-timeout are reachable in a normal demo session.

The chrome renders a persistent _DEMO SERVICE_ placard
(`client/src/chrome/Chrome.tsx` `ModeTreatment`) that is never
dismissible. Demo is never mistakable for live.

## Source-loss and recovery semantics

The server keeps a `health: watch::Sender<bool>` per connected
WebSocket. The live loop flips it to `false` after three consecutive
adapter errors and the WS loop closes the connection
(`server/src/feed.rs`, `server/src/service.rs`).

After source loss, health is restored only after a fresh snapshot has been
fetched, normalized, and installed as the complete live roster. A reconnecting
WebSocket still receives that snapshot before any delta.

The client mirrors this with a 2.9 s liveness budget. Any of the
following keeps the client in `live`:

- A snapshot frame.
- A delta frame.
- A typed heartbeat frame (1 Hz, server-driven).

Silence longer than 2.9 s flips the client mode to `disconnected`,
shows the `GAS LEAK — SERVICE SUSPENDED` overlay, schedules a
reconnect in 1 s, and applies the next fresh snapshot on reopen
(`client/src/state/ws-client.ts`).

```text
  feed healthy (heartbeat 1 Hz)        client mode = live
  feed silent > 2.9 s (no heartbeat)   client mode = disconnected (overlay)
  reconnect 1 s later                  client.mode back to live on next open
  feed unhealthy (3 adapter errors)    server closes WS, client reconnects
```

There is no state replay on resume: the client always reconciles to
the current snapshot. Re-`Esc` presses do not animate the catch-up.

## Graceful shutdown

`axum::serve(...).with_graceful_shutdown(...)` is wired to
`tokio::signal::ctrl_c()` in `server/src/main.rs`. On `SIGINT` the
server cancels the live/retry tasks, closes the loopback
listener, and exits within ~1 s with an open WebSocket. The release
smoke (`scripts/smoke-release.sh`) sends `SIGINT` after the snapshot
assertion and checks that the process exits cleanly.

## Package and checksum verification

### Building a release archive locally

```sh
sh scripts/package-release.sh
# writes:
#   dist/herdr-mise-v<VERSION>-<TARGET>.tar.gz
#   dist/herdr-mise-v<VERSION>-<TARGET>.tar.gz.sha256
```

The script targets the current `uname -s`/`uname -m` pair. Supported
local pairs are macOS aarch64, macOS x86_64, and Linux x86_64; anything
else exits non-zero with a clear message.

### Verifying an archive

From the directory that holds both files:

```sh
# macOS
shasum -a 256 -c herdr-mise-v0.1.0-aarch64-apple-darwin.tar.gz.sha256

# Linux
sha256sum -c herdr-mise-v0.1.0-x86_64-unknown-linux-gnu.tar.gz.sha256
```

The sidecar is written next to the archive and names the archive basename
only. The release workflow verifies checksums before upload and again after
public download. End-to-end local verification of a packaged archive:

```sh
sh scripts/verify-release-artifact.sh dist/herdr-mise-v0.1.0-aarch64-apple-darwin.tar.gz
# optional on a signed macOS binary after extract:
# VERIFY_CODESIGN=1 sh scripts/verify-release-artifact.sh path/to/archive.tar.gz
```

### Publishing a signed release

Signing, Apple trust setup, tag publication, public verification, and failure
recovery are maintained in the sole operator runbook:
[Release operations](releasing.md).

### Verifying the binary from a source tree

```sh
sh scripts/validate-release.sh
```

This is the same gate the CI workflow runs on non-tag validation paths. It:

1. Confirms `target/release/herdr-mise` exists and is executable.
2. Asserts the release workflow declares all three matrix targets and
   the `tar.gz` and `sha256` artifacts.
3. Runs `scripts/smoke-release.sh`, which launches the binary with
   an isolated empty socket, fetches the SPA, asserts the
   `assets/...js` entry, opens the WebSocket, and asserts the
   snapshot has `mode: "demo"` with 12 agents.
4. Runs `scripts/measure-server.sh`, which samples the running
   process and asserts RSS ≤ 50 MiB and CPU ≤ 1% of one core.

## Supply-chain checks

Every external action in `.github/workflows/` is pinned to a full upstream
commit SHA. The trailing version comment is for maintainers; the SHA is the
executed identity. The weekly `github-actions` entry in
`.github/dependabot.yml` proposes pin updates while preserving that model.
`scripts/workflow-contract.test.mjs` audits every workflow and uses mutation
fixtures to prove that mutable references and weakened security controls are
rejected.

Hosted pull requests run the following checks:

- CI installs npm dependencies with the committed lockfiles, runs Cargo
  build/check/test commands with `--locked`, and installs exactly
  `cargo-audit` 0.22.2 with `--locked` before auditing the committed
  `Cargo.lock`.
- CodeQL analyzes the explicit `javascript-typescript` and `rust` matrix.
  Both use the supported `build-mode: none`; no autobuild step is required.
- Dependency review rejects newly introduced vulnerabilities of moderate or
  greater severity. It reports through the check run and does not write a PR
  comment.
- Gitleaks 8.30.1 scans the push or pull-request event's commit range with
  `.gitleaks.toml`. Checkout fetches complete history so the range and its
  parents resolve, but the hosted scan does not rescan unrelated historical
  commits. Findings are redacted and PR comments are disabled. The config
  extends the default rules and allows only the RFC 6455 sample WebSocket
  nonce, constrained by both its exact value and the exact
  `server/src/service.rs` path. This is a standards fixture exception, not a
  general test-file allowlist.

Run the equivalent repository-controlled checks from a full local clone:

```sh
npm ci
npm ci --prefix client
npm test

cargo install cargo-audit --version 0.22.2 --locked
cargo audit --file Cargo.lock --deny warnings

gitleaks git --config .gitleaks.toml --redact . # use Gitleaks 8.30.1
```

Run the local Gitleaks command from a complete clone with Gitleaks 8.30.1. It
scans all repository history, so it is a stricter superset of the hosted
event-range scan. Version 8.30.1 supports the root plural `[[allowlists]]` and
`condition = "AND"` used by this repository. CodeQL SARIF upload and GitHub
dependency review have no repository-local equivalent; use the ordinary
locked build/test commands for fast feedback, then rely on their pull-request
checks for authoritative results.

The advisory check intentionally fails closed: `--deny warnings` rejects
vulnerabilities as well as warning categories including unmaintained, unsound,
and yanked dependencies. The executable and its installation resolution are
pinned, while findings can still change as the live RustSec advisory database
is updated. There are no ignored advisories. If a future advisory is proven
non-applicable and cannot yet be fixed, add only its exact `RUSTSEC-*` ID to a
committed `.cargo/audit.toml` `[advisories].ignore` list. Its adjacent TOML
comment must record the affected dependency path or feature, reason, owner,
and review or expiry date. Never use a wildcard, a crate-wide suppression, or
an undocumented workflow `--ignore`; remove the exception when the dependency
graph changes.

All workflows declare permissions explicitly. Pull-request workflows use
`pull_request`, never `pull_request_target`; they require read-only contents
except for CodeQL's `security-events: write` result upload. The Gitleaks scan
passes the automatic `github.token` explicitly and grants that job exactly
`contents: read` plus `pull-requests: read`, which the pinned action needs to
list a PR's commits. Those read scopes remain fork-safe, and fork pull requests
receive no repository secrets. GitHub downgrades CodeQL's write permission for
fork pull requests. The only `contents: write` grant remains the release
publish job, which is gated to `v*` tags. Apple signing and notarization secret
paths are likewise tag- and macOS-gated. Non-release workflows use bounded
timeouts and cancel superseded runs; release cancellation remains disabled so
publication cannot be interrupted midway.

Some controls can only be verified on GitHub: code-scanning enablement and
SARIF ingestion, CodeQL behavior when a fork token cannot upload results, the
dependency graph and dependency-review availability, branch-protection
required checks, Gitleaks licensing for organization-owned repositories,
hosted-runner compatibility, and Dependabot's actual SHA update PRs. Validate
those settings and observe both a same-repository and fork pull request before
treating all hosted checks as enforced.

## Diagnostics

### `?stats` overlay

Append `?stats` to the URL once. The chrome renders a draw-call and
socket-rate panel that updates once a second
(`client/src/App.tsx`, `client/src/chrome/Chrome.tsx`). Press `s` to
toggle.

The overlay is excluded from perf budgets when hidden. `npm run
perf` toggles it from the harness via Playwright.

### Server resource measurement

`scripts/measure-server.sh` boots the binary with an isolated empty
socket, waits 3 s, samples `ps -o pid,rss,%cpu`, and asserts RSS and
CPU budgets. It also writes the raw evidence under
`perf/artifacts/server-resource.txt` and the full process log under
`perf/artifacts/server-resource.log`. Override the binary with
`scripts/measure-server.sh path/to/herdr-mise` and the artifact
directory with `HERDR_MISE_ARTIFACT_DIR=...`.

### Smoke test

`scripts/smoke-release.sh` is the all-in-one boot check: spawn the
binary with an empty socket, wait for the SPA to come up, parse the
entry asset, open the WebSocket, assert the snapshot is the
expected demo roster, and assert graceful shutdown on `SIGINT`.

### Token, architecture, and accessibility audits

Run from the repo root:

```sh
npm run audit:tokens          # service red must be blocked-only
npm run audit:architecture    # native Pixi classes only
npm run audit:accessibility   # Chrome and day/dinner station labels ≥ 4.5:1
```

These run in CI (`scripts/audit-*.mjs`).

## Troubleshooting

### Herdr socket unavailable

The server cannot reach the Herdr Unix socket. The chrome shows the
persistent `DEMO SERVICE` placard and the typed `sourceStatus` is
`unavailableSocket` or `timeout` (`server/src/feed.rs`,
`server/src/discovery.rs`). Causes and checks:

- Herdr is installed but not running. Start the Herdr server and
  confirm its documented socket path exists. The current Herdr
  stable release and install options are at
  <https://github.com/herdrdev/herdr/releases>.
- `HERDR_SOCKET_PATH` overrides the default. Unset it to use the
  Herdr-discovered path, or set it to the exact path Herdr reports.
  Discovery precedence is documented in
  [socket override](#socket-override).
- The resolved socket path exceeds `sun_path` (104 chars), which can
  happen with deeply nested `HERDR_SOCKET_PATH` values. Pick a path
  under `/tmp` or `$HOME/.local` to stay well under the limit.
- A sandboxed shell is blocking loopback binds. Run the binary
  outside the sandbox.

Once the socket is reachable, the server fetches and normalizes a
fresh snapshot before it atomically swaps the demo roster for the
live roster — no restart or browser reload is needed.

### Herdr protocol not supported

The server reached the socket, but the snapshot advertised a
protocol outside the supported set. The chrome shows the persistent
`DEMO SERVICE` placard and the typed `sourceStatus` is
`unsupportedProtocol` (`server/src/adapter.rs` `AdapterError::Protocol`).

The adapter derives its supported protocols from
`compatibility/herdr.json`. A snapshot with any other
`protocol` value is rejected as `unsupportedProtocol`; this is the
only path that produces that demo condition. Other product
versions that ship a protocol in the manifest are accepted by the
adapter but are not part of the verified matrix above. The exact
tested matrix is:

<!-- herdr-compatibility:start -->

| Herdr release | Snapshot protocol |
| ------------- | ----------------- |
| `0.7.5`       | `17`              |
| `0.8.0`       | `19`              |
| `0.8.2`       | `20`              |

<!-- herdr-compatibility:end -->

If you are on a Herdr version that reports a different protocol,
either upgrade Herdr to a tested release or stay on the demo
placard; the binary will not synthesize a live feed outside the
supported protocol set. Herdr releases on a supported protocol
that are not in the verified table above are accepted by the
adapter but are outside the tested release matrix.

The demo snapshot includes a safe diagnostic for this case: the observed
protocol, the supported protocol list, and the action to upgrade or downgrade
Herdr to a tested release and retry. Malformed or incomplete snapshots remain
`incompatibleResponse` and never echo payloads or local paths.

#### Maintaining Herdr support

`compatibility/herdr.json` is the single authority. Run
`npm run check:herdr-compatibility` locally; it is deterministic, read-only,
credential-free, and does not contact the network. The scheduled/manual
workflow additionally checks source at the immutable commits recorded there.

- Add support only after inspecting an immutable upstream commit. Add one
  manually sanitized fictional fixture, its manifest row, and adapter mapping
  coverage together, then update both marked public tables and run all gates.
- Deprecate support by retaining its fixture and tests, recording the decision
  and removal target in the same change, and keeping diagnostics truthful.
- Remove support only through a deliberate compatibility change that removes
  the manifest claim, public row, primary fixture, and adapter coverage
  together. Never leave a docs-only or runtime-only claim.

### The overlay says _GAS LEAK — SERVICE SUSPENDED_

- A typed heartbeat should arrive every 1 s. If it stops, the server
  has lost the herdr socket or the live loop has dropped to
  unhealthy. The chrome always shows `last update Ns ago`; the
  counter is the age of the last snapshot or delta, not the last heartbeat.
- The client reconnects in 1 s. The overlay's `last update` value measures the
  age of the last state-bearing snapshot or delta; heartbeats prove liveness but
  intentionally do not rewrite that data timestamp. If reconnect keeps failing,
  confirm that the herdr daemon is running and reachable at the
  resolved socket path. Re-check `HERDR_SOCKET_PATH`,
  `XDG_CONFIG_HOME`, and `HOME`.
- On macOS the herdr Unix socket path can exceed `sun_path` (104
  chars). The demo path under a real `$HOME` is fine; a custom
  `HERDR_SOCKET_PATH` under a deeply nested temp directory is
  suspicious. Pick a path under `/tmp` or `$HOME/.local` to stay
  well under the limit.

### The kitchen looks busy but nothing changes

- This is the demo profile. Realistic dwell is the point: Codex
  repeats working → blocked → working → done, Claude stays blocked,
  and Gemini ends once per five-minute session. If you want to see
  the blocked escalation stages more often, lower the `faster bell`
  and `screen-edge glow` thresholds in _Settings_ to 30 s and
  3 min respectively.
- If you are running against a live herdr, the source of truth is
  the herdr pane — herdr-mise only reflects what herdr reports.

### The binary will not bind to its loopback port

- The TCP listener uses `127.0.0.1:8686` by default. Something on the host is
  already on the effective port; release it or set `HERDR_MISE_PORT` to an
  available unprivileged port and retry.
- If you are inside a sandboxed shell that blocks loopback binds
  (for example, `listen EPERM 127.0.0.1:8686`), run the binary outside the
  sandbox. The release smoke has a documented guard for this.

### Settings do not stick across reloads

- The settings are stored at `localStorage["herdr-mise:settings"]`
  as a version-1 record. Storage can be disabled, full, or
  throwing under hardened/private browser modes. The loader
  tolerates each case with field-safe defaults
  (`client/src/state/settings-storage.ts`).
- The settings storage key is fixed; clearing site data wipes it.

### Performance gate drift

- The hidden-tab gate uses a 60 s fixed measurement window after a 1 s settle
  to keep host noise from dominating the result.
- The server-resource gate is enforced by `scripts/measure-server.sh` and
  asserts both RSS and CPU. If the assertion fails, the binary
  has regressed; the artifact is recorded under
  `perf/artifacts/server-resource.txt`.

### Visual baseline disagrees with the rendered scene

- The accepted baseline is
  `perf/client.perf.spec.ts-snapshots/demo-service-darwin.png`. If the perf
  suite reports a meaningful pixel diff, investigate the scene change and
  re-baseline deliberately only when the new rendering is correct.
