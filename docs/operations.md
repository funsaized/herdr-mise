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
[architecture.md](architecture.md); current product behavior and release gates
are documented in the root [README](../README.md).

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

### Run the release archive

Public distribution is the GitHub **prerelease** created by pushing a matching
`v*` tag. Each asset pair is:

```text
herdr-mise-v<VERSION>-<TARGET>.tar.gz
herdr-mise-v<VERSION>-<TARGET>.tar.gz.sha256
```

Targets:

| Platform | `TARGET` |
|---|---|
| macOS Apple Silicon | `aarch64-apple-darwin` |
| macOS Intel | `x86_64-apple-darwin` |
| Linux x86_64 | `x86_64-unknown-linux-gnu` |

Download, verify, extract, and run from the upstream release:

```sh
TAG=v0.1.0-rc.1
TARGET=aarch64-apple-darwin   # or x86_64-apple-darwin / x86_64-unknown-linux-gnu
BASE=herdr-mise-${TAG}-${TARGET}
URL=https://github.com/funsaized/herdr-mise/releases/download/${TAG}

curl -fsSL -O "$URL/$BASE.tar.gz" -O "$URL/$BASE.tar.gz.sha256"

# macOS:
shasum -a 256 -c "$BASE.tar.gz.sha256"
# Linux:
# sha256sum -c "$BASE.tar.gz.sha256"

tar -xzf "$BASE.tar.gz"
./herdr-mise
# open http://127.0.0.1:8686
```

The archive contains three top-level files (no nested directory): the
`herdr-mise` executable, the project `LICENSE`, and generated
`THIRD_PARTY_NOTICES.txt` covering the locked production dependency trees and
bundled font licenses. The binary serves the embedded client, opens the
WebSocket, and tails the herdr socket (or runs the demo feed). It binds to
`127.0.0.1:8686` only (`server/src/main.rs`).

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
`/ws` endpoint only — the native constructor is preserved and
delegated for every other URL, including Vite HMR and any
unrelated socket. The real `AgentWebSocketClient` still opens
`/ws` against the live origin; the mock simply answers on the
client side. Source: `client/src/main.tsx`,
`client/src/runtime.ts`, `client/src/visual-harness.ts`.

#### Query contract

| Parameter | Accepted values          | Default   | Notes |
|-----------|--------------------------|-----------|-------|
| `preset`  | `idle\|working\|blocked\|done\|ended\|mixed` | `mixed` | Any other value falls back to `mixed`. |
| `agents`  | Integer from `1` through `12` | `6`       | Absent, non-integer, non-finite, or out-of-range values fall back to `6`. |
| `theme`   | `light\|dinner`          | `light`   | `dinner` selects the existing dark lighting. |

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
and runs in CI via `npm run test:visual`. It starts the real root
`npm run dev:visual` entry point (port 4174) and covers every preset and
supported count, the ended 86-board flow, the exact dinner URL,
invalid-query fallback, storage isolation, native non-`/ws` delegation
(Vite HMR connects), and liveness beyond the client stale timeout.

This is a client-development harness check, not full-product release
acceptance. Use the root README's verification commands for the integrated
Rust server, source-loss recovery, accessibility, packaging, and release gates.

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

## Socket override

`server/src/discovery.rs` resolves the herdr Unix socket in this
order:

1. `HERDR_SOCKET_PATH` (non-empty).
2. `$XDG_CONFIG_HOME/herdr/herdr.sock` (if `XDG_CONFIG_HOME` set).
3. `$HOME/.config/herdr/herdr.sock` (if `HOME` set).
4. `./.config/herdr/herdr.sock` as a final fallback.

The probe is bounded to 2 s; on timeout or any adapter error
(connect refused, protocol mismatch, malformed JSON) the server
falls back to demo mode and the snapshot is labeled `"mode": "demo"`.

Useful overrides:

```sh
# point at a specific herdr socket
HERDR_SOCKET_PATH=/tmp/herdr.sock ./target/release/herdr-mise

# force demo even when herdr is installed
HERDR_SOCKET_PATH=/tmp/this-socket-does-not-exist.sock ./target/release/herdr-mise

# change demo roster size (default 6, max 12)
HERDR_MISE_DEMO_COUNT=12 ./target/release/herdr-mise
```

## Remote viewing through a personal reverse proxy

The binary always binds to `127.0.0.1:8686` and that does not change.
By default the `/ws` endpoint also rejects any browser `Origin` other
than `http://localhost:8686` / `http://127.0.0.1:8686`, so a page
served through a reverse proxy loads but its WebSocket is refused
with HTTP 403 and the client shows *GAS LEAK — SERVICE SUSPENDED*.

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

The chrome renders a persistent *DEMO SERVICE* placard
(`client/src/chrome/Chrome.tsx` `ModeTreatment`) that is never
dismissible. Demo is never mistakable for live.

## Source-loss and recovery semantics

The server keeps a `health: watch::Sender<bool>` per connected
WebSocket. The live loop flips it to `false` after three consecutive
adapter errors and the WS loop closes the connection
(`server/src/feed.rs`, `server/src/service.rs`).

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
server cancels the live/demo/coalescer tasks, closes the loopback
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
shasum -a 256 -c herdr-mise-v0.1.0-rc.1-aarch64-apple-darwin.tar.gz.sha256

# Linux
sha256sum -c herdr-mise-v0.1.0-rc.1-x86_64-unknown-linux-gnu.tar.gz.sha256
```

The sidecar is written next to the archive and names the archive basename
only. The release workflow verifies checksums before upload and again after
public download. End-to-end local verification of a packaged archive:

```sh
sh scripts/verify-release-artifact.sh dist/herdr-mise-v0.1.0-rc.1-aarch64-apple-darwin.tar.gz
# optional on a signed macOS binary after extract:
# VERIFY_CODESIGN=1 sh scripts/verify-release-artifact.sh path/to/archive.tar.gz
```

### Publishing a signed prerelease

Publication is **tag-triggered and prerelease-only**. Pushing a matching `v*`
tag is the only path that signs, notarizes, and publishes. Pull requests and
`workflow_dispatch` builds validate without secrets or publication.

#### Preconditions

1. Working tree matches the intended release commit on `main` (or the branch
   you intentionally tag). No dirty release-critical paths.
2. `server/Cargo.toml` `version` is the single source of truth (currently
   `0.1.0-rc.1`). The tag **must** be that value with a `v` prefix
   (`v0.1.0-rc.1`). The workflow fails if `GITHUB_REF_NAME != v$version`.
3. Local gates you care about have passed on that commit
   (`npm test`, `npm run build`, `cargo test --workspace --locked`,
   `npm run validate:release`, etc.).
4. The six Apple secrets below are already set on the GitHub repository
   (required only for the tagged macOS jobs).

#### One-time Apple trust setup

Use a **Developer ID Application** certificate (not Mac App Distribution).
Account Holder access is required; Apple limits an organization to five
Developer ID Application certificates
([Apple certificate docs](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)).

1. In Certificates, Identifiers & Profiles, create a **Developer ID
   Application** certificate, install it (with its private key) in Keychain
   Access, and export that identity as a password-protected `.p12`.
2. Record the full signing identity string shown by Keychain / `security`
   (form: `Developer ID Application: … (TEAMID)`).
3. In App Store Connect → Users and Access → Integrations → App Store Connect
   API, create a **Team Key** (not an Individual Key) with the App Manager role.
   Individual keys cannot use `notarytool`. Download the `.p8` **once**, and
   record the Key ID and Issuer ID
   ([Apple notarization docs](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)).
4. Keep the `.p12`, its password, and the `.p8` on disk only. Never paste
   them into chat, tickets, or shell history.

Encode file secrets locally without printing values:

```sh
openssl base64 -A -in DeveloperID.p12 -out certificate.p12.base64
openssl base64 -A -in AuthKey_KEYID.p8 -out AuthKey.p8.base64
```

From a checkout with `gh` authenticated to the repository, set exactly these
six secrets (interactive commands read a hidden value from stdin and do not
echo it; file redirects never place the payload on the argv list):

```sh
gh secret set APPLE_CERTIFICATE_P12_BASE64 < certificate.p12.base64
gh secret set APPLE_CERTIFICATE_PASSWORD
gh secret set APPLE_SIGNING_IDENTITY
gh secret set APPLE_API_KEY_ID
gh secret set APPLE_API_ISSUER_ID
gh secret set APPLE_API_PRIVATE_KEY_BASE64 < AuthKey.p8.base64
```

| Secret | Contents |
|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password protecting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | full `Developer ID Application: …` identity string |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_ISSUER_ID` | App Store Connect issuer ID |
| `APPLE_API_PRIVATE_KEY_BASE64` | base64 of the API key `.p8` |

Delete the local `.base64` helpers after upload. Never commit source certs or
encoded copies. GitHub's
[temporary-keychain pattern](https://docs.github.com/en/actions/how-tos/use-cases-and-examples/deploying/installing-an-apple-certificate-on-macos-runners-for-xcode-development)
is what the workflow uses on the runner.

#### Tag and publish

On the release commit:

```sh
# confirm authoritative version
sed -n '/^\[package\]/,/^\[/s/^version = "\([^"]*\)"/\1/p' server/Cargo.toml
# -> 0.1.0-rc.1  implies tag v0.1.0-rc.1

git status   # clean
git tag -a v0.1.0-rc.1 -m "v0.1.0-rc.1"
git push origin v0.1.0-rc.1
```

Then:

1. Open the Actions **Release** workflow for that tag and wait for
   `build` → `publish` → `verify-public-release`.
2. Confirm the GitHub release for the tag is marked **prerelease**, titled
   with the tag name, and lists exactly six assets:
   - `herdr-mise-v0.1.0-rc.1-aarch64-apple-darwin.tar.gz` + `.sha256`
   - `herdr-mise-v0.1.0-rc.1-x86_64-apple-darwin.tar.gz` + `.sha256`
   - `herdr-mise-v0.1.0-rc.1-x86_64-unknown-linux-gnu.tar.gz` + `.sha256`
3. Spot-check a public browser download URL of the form
   `https://github.com/funsaized/herdr-mise/releases/download/v0.1.0-rc.1/...`
   and re-run the checksum + extract steps from the install section.

#### What the tagged workflow does

- Matrix: `macos-15` → `aarch64-apple-darwin`, `macos-15-intel` →
  `x86_64-apple-darwin`, `ubuntu-24.04` → `x86_64-unknown-linux-gnu`.
- macOS jobs import the P12 into an ephemeral keychain, sign with
  `--options runtime --timestamp`, submit a ZIP via API-key
  `notarytool --wait`, then re-verify the Developer ID signature. Missing
  secrets fail closed.
  Credential files and the keychain are deleted in an `always()` cleanup.
- Packaging writes `herdr-mise-v<VERSION>-<TARGET>.tar.gz` plus a SHA-256
  sidecar; `scripts/verify-release-artifact.sh` runs before upload.
- `publish` creates or validates a **prerelease** for the tag, uploads all
  six files with `--clobber`, and asserts the final asset name set is exact.
- `verify-public-release` downloads via the unauthenticated public API /
  browser URLs and re-runs the full verifier (`VERIFY_CODESIGN=1` on macOS).

#### Standalone CLI notarization (no stapling)

This product is a standalone Mach-O command-line executable, not an app
bundle. There is **no stapling target**. Applicable evidence is:

1. `notarytool` reports the submission accepted,
2. the Developer ID signature remains on the binary, and
3. the signature retains the hardened-runtime flag and secure timestamp.

Do not claim or require `xcrun stapler` for this binary. Also do not use
Apple's app-assessment tool as the acceptance gate for the extracted bare
executable: it can reject a valid, accepted CLI because the code is not an
app bundle. The notarization service result and Developer ID signature are
the relevant evidence.

#### Runner horizon

The workflow pins the current explicit `macos-15-intel` x86_64 label for
release reproducibility. GitHub currently documents support through **August
2027** (migration path after the
[macOS 13 retirement](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/)
and [runner-images #13045](https://github.com/actions/runner-images/issues/13045)).
GitHub also publishes newer Intel images, so review the
[current runner inventory](https://github.com/actions/runner-images#available-images)
before each release and move the pin deliberately. Do not silently drop the
Intel artifact when a label is retired.

### Failure recovery

**Missing or mis-scoped Apple secrets.** Tagged macOS jobs assert every
secret is non-empty and fail before packaging. Fix the secret with
`gh secret set …` (same six names), then re-run the failed jobs from the
Actions UI, or delete the bad tag and push a corrected one only if you
intentionally retag. PR / manual runs never need these secrets.

**Notarization rejection.** Open the failed **Notarize signed CLI binary**
step log for the `notarytool` submission id. On a machine with the API key
material loaded into temporary files (not committed), fetch the Apple log:

```sh
xcrun notarytool log SUBMISSION_ID \
  --key /path/to/AuthKey_KEYID.p8 \
  --key-id KEYID \
  --issuer ISSUER_ID
```

Common causes: wrong certificate type (must be Developer ID Application),
missing hardened runtime / timestamp, or an API key without notarization
permission. Fix the signing inputs, update secrets if needed, and re-run the
tag workflow.

**Partial GitHub asset upload.** `publish` allows an existing prerelease for
the same tag/title to retain any **subset** of the six expected names, rejects
unexpected names, then re-uploads all six with `--clobber` and diffs the final
set. Re-run the failed `publish` (or the whole tag workflow). Do not hand-edit
release assets into a different naming scheme.

**Code-signature verification failure on a public macOS download.** Confirm
you extracted the public prerelease asset (not a local unsigned build), then
inspect and verify it explicitly:

```sh
tar -xzf herdr-mise-v0.1.0-rc.1-aarch64-apple-darwin.tar.gz
codesign --verify --deep --strict --verbose=2 ./herdr-mise
codesign -dv --verbose=4 ./herdr-mise
```

Require a Developer ID Application authority, a TeamIdentifier, the runtime
flag, and a secure timestamp. If CI's `verify-public-release` failed the same
check, treat it as a signing defect and re-run after fixing the certificate or
packaging path.

**Intel runner / platform risk.** If `macos-15-intel` jobs queue forever or
the label is removed before Aug 2027, stop and update the workflow labels —
do not ship a release missing `x86_64-apple-darwin`.

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

### The overlay says *GAS LEAK — SERVICE SUSPENDED*

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
  and `screen-edge glow` thresholds in *Settings* to 30 s and
  3 min respectively.
- If you are running against a live herdr, the source of truth is
  the herdr pane — herdr-mise only reflects what herdr reports.

### The binary will not bind to `127.0.0.1:8686`

- The TCP listener is hardcoded to `127.0.0.1:8686` and there is no
  override (`server/src/main.rs`). Something on the host is already
  on that port; release it and retry.
- If you are inside a sandboxed shell that blocks loopback binds
  (`listen EPERM 127.0.0.1:8686`), run the binary outside the
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
