# herdr-mise

A read-only kitchen view of local Herdr agents. The Rust binary serves an
embedded React/Pixi browser client and a ratatui TUI from one shared Feed.

## Working agreement

- Work from the user's task or accepted GitHub issue. Inspect callers and the
  smallest relevant source path before editing. Keep unrelated work intact.
- Use direct repository tools and ordinary branches/PRs. Scope, decisions and
  review belong in the issue/PR; CI logs are the execution record.
- Make the smallest root-cause change. Add abstractions only for existing needs.
- Preserve the read-only product boundary: no approving, prompting, killing,
  reading agent output, or remote control of sessions.
- Keep Herdr normalization in `server/src/adapter.rs`, shared source state in
  `feed.rs`, transport in `service.rs`, and presentation in the browser/TUI.
- Preserve truthful Live/Demo/Disconnected/Empty states, stable terminal identity,
  bounded resources, loopback binding, and WebSocket Origin validation.
- React owns controls and accessibility; Pixi owns the scene and animation.
  Keep browser tokens in `client/src/theme/` and TUI tokens in `tui/theme.rs`.
  Blocked state must use text/shape as well as color. Respect reduced motion.
- Keep protocol facts in `protocol/` and compatibility pins/fixtures in
  `compatibility/herdr.json`. Fixtures must be sanitized.

## Setup and verification

Requires Node 22+ and the Rust toolchain in `rust-toolchain.toml`:

```sh
npm ci
npm ci --prefix client
npm run doctor
```

Run focused checks during development; use `npm run check` for format, types and
lint, `npm test` for Node/client/release tests, `npm run audit` for compatibility
and presentation audits, and `npm run verify:rust` for Rust checks. Use existing
Herdr fixtures to prove changes across the normalizer/Feed/WebSocket/TUI boundary;
use Testing Library or Playwright for browser interaction changes. Verify that a
selected test actually ran. Report commands, results and limitations honestly.

`npm run verify:browser:install` installs browsers. `npm run verify` runs the full
local product suite; it tests fallback assets before building the embedded client.
Avoid concurrent builds/tests in the same checkout. Separate worktrees have
separate browser ports (`HERDR_MISE_VISUAL_PORT` overrides the default).

Every ready PR head gets native product verification and a trusted exact-head
status. CI policy changes require an owner-authored same-repository PR. See
`docs/local-verification.md`. Merge only when current-head required checks pass
and the user has authorized merging. Release publication remains separate.

Media maintenance is opt-in: `npm run media -- --help` and `npm run test:media`.
See `docs/product-demo.md`; ordinary development does not need capture tools.
