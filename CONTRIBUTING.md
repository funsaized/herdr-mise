# Contributing to herdr-mise

Thanks for looking under the hood. This is a small project with strong
opinions; the docs below will save you time.

## Orientation

- [GitHub issues](https://github.com/funsaized/herdr-mise/issues) — the current
  authority for accepted bugs, planned work, ownership, and status. Issue
  discussion and status supersede repository planning snapshots.
- `docs/architecture.md` — how the pieces fit (Rust server, TypeScript client,
  versioned protocol).
- `docs/operations.md` — how to run, develop, and verify locally.
- `README.md` — product behavior, deliberate boundaries, and installation.

## Setup

```sh
npm ci
npm ci --prefix client
npm run doctor       # checks tool versions and installed-vs-locked dependencies
npm run bundle        # builds the client and the release binary
```

Client-only iteration needs no Rust at all:

```sh
npm run dev:visual    # isolated playground on http://localhost:8686
```

## Your first small change

[GitHub issues](https://github.com/funsaized/herdr-mise/issues) remain the
authority for accepted work. Start with the maintained
[good first issue filter](https://github.com/funsaized/herdr-mise/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22)
rather than repository planning snapshots.

### Browser presentation

1. Run `npm run dev:visual` and open
   <http://localhost:8686/?preset=blocked&agents=1&theme=light>.
2. Make the smallest accepted change in the owning presentation file, such as
   `client/src/scene/kitchen-scene.ts`. Preserve the demo placard and blocked
   indicators that use text and shape as well as color.
3. Inspect the page for the intended visible result, then run
   `npm run test:visual -- visual-matrix.spec.ts --grep "blocked x 1 renders every station"`.

See the [visual playground query contract](docs/operations.md#query-contract)
for preset details.

### Herdr normalization to visible TUI

1. Trace the sanitized
   `server/tests/fixtures/snapshot-herdr-0.8.2-p20.json` through
   `server/src/adapter.rs` (`Normalizer`), `server/src/tui/state.rs`
   (`AgentTable`), and `server/src/tui/view.rs`.
2. Change only the accepted normalization behavior and its corresponding
   visible assertion. Do not edit the compatibility fixture unless new upstream
   evidence changes the accepted contract.
3. Run
   `cargo test -p herdr-mise-server real_herdr_snapshot_drives_keyboard_inspection_lifecycle`
   and `npm run check:herdr-compatibility`.

For either path, run focused checks while developing. Use Node 22+ and the
Rust toolchain in `rust-toolchain.toml`; install its `rustfmt` and `clippy`
components. Run both locked `npm ci` installs after dependency changes.
`npm run doctor` checks tool versions and installed dependency drift.

## Before you open a PR

Run `npm run check`, `npm test`, and the relevant Rust/browser checks. For the
complete product suite, install browsers with `npm run verify:browser:install`
and run `npm run verify`. Open a ready PR from a branch based on current `main`.
Native CI verifies every exact PR head; inspect its logs rather than relying on
an agent's test summary. See [Product verification](docs/local-verification.md)
for commands, trust-boundary changes and merge policy.

Read [AGENTS.md](AGENTS.md) for the shared agent contract. GitHub issues and PRs
hold scope, decisions and review; a normal agent session uses repository tools
directly. Use a fresh review session for substantial or sensitive changes.

Media capture and validation are opt-in maintenance tasks under `scripts/media/`.
Use `npm run media -- --help` and [Media maintenance](docs/product-demo.md).

## Reporting bugs

Use the [bug report template](https://github.com/funsaized/herdr-mise/issues/new?template=bug_report.md).
Provide either a deterministic playground preset URL or sanitized, fictional
reproduction data—never private Herdr data.

For security issues, see [SECURITY.md](SECURITY.md) instead.
