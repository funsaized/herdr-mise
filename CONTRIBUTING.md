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
  Code plus passing tests wins when prose and behavior disagree.

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

For either path, run only the named narrow checks before the existing pull
request handoff below. A maintainer dispatches `Swamp managed verification` for
the current pull request head. Autonomous implementation, the full local
verification workflow, and release-acceptance commands are not part of these
small-change recipes.

Managed CI uses Node 22 and the Rust version in `rust-toolchain.toml`.
`rustup` installs that named toolchain automatically; install its `rustfmt` and
`clippy` components when provisioning offline. Use the exact Swamp version in
`.swamp.yaml`; extension tests use Swamp's bundled Deno (or `DENO_EXEC_PATH`).
`npm run doctor` reports actual versions and rejects direct dependency drift.
Run both `npm ci` commands after lockfile changes, not just `npm install`.
On sandboxed macOS, if Swamp reports `SecTrustSettingsCopyCertificates`, use
`DENO_TLS_CA_STORE=mozilla swamp ...` (or run in a terminal with certificate
access). This selects Mozilla trust roots; it does not disable TLS verification.

For the cross-browser critical path, install Chromium, Firefox, and WebKit with
`npm run verify:browser:install`, then run
`HERDR_MISE_CROSS_BROWSER=1 npm run test:visual`. Browser automation is not a
replacement for the recorded human screen-reader pass.

## Before you open a PR

Use narrow checks while developing and open the pull request from a clean,
committed branch based on current upstream `main`. The full local Swamp workflow
is optional advisory feedback:

```sh
swamp workflow validate verification
swamp workflow run verification \
  --input commit=$(git rev-parse HEAD) \
  --input baseCommit=$(git rev-parse upstream/main) \
  --input subjectRoot=.
```

Before merge, a maintainer reviews the current head and dispatches the
`Swamp managed verification` GitHub workflow with the pull request number. The
required status applies only to that exact head; every new commit requires a new
dispatch. Trust-boundary changes require dispatch by `@funsaized` and run using
the trusted controls from `main`.

See [Managed verification](docs/local-verification.md) for the contributor and
maintainer runbook.

Run `npm run format` to apply the repository's deterministic Oxfmt formatting
before checking it with `npm run format:check`.

### Verification commands

Run the narrow checks relevant to your change while developing. These are the
complete locally runnable gates:

| Gate                       | Command                           |
| -------------------------- | --------------------------------- |
| Rust format                | `cargo fmt --all --check`         |
| Rust check                 | `cargo check --workspace`         |
| Rust tests                 | `cargo test --workspace --locked` |
| Repository format          | `npm run format:check`            |
| Client typecheck           | `npm run typecheck`               |
| JavaScript/TypeScript lint | `npm run lint`                    |
| Unit and contract tests    | `npm test`                        |
| Extension tests            | `npm run test:extensions`         |
| Token audit                | `npm run audit:tokens`            |
| Architecture audit         | `npm run audit:architecture`      |
| Accessibility audit        | `npm run audit:accessibility`     |
| Production build           | `npm run build`                   |
| Bundle budget              | `npm run check:bundle`            |
| Embedded-binary smoke      | `npm run smoke`                   |
| Server resources           | `npm run measure:server`          |
| Release pipeline           | `npm run validate:release`        |
| Performance suite          | `npm run perf`                    |

Ground rules that reviews will enforce:

- **Truthfulness over polish.** The UI never invents data. Metrics the feed
  doesn't carry render as `Unavailable`, not as plausible numbers.
- **Performance is a feature.** Bundle, wire-rate, idle-CPU, and hidden-tab
  budgets are tested; changes that regress them need a measured justification.
- **The blocked state is sacred.** Anything that makes a blocked agent less
  obvious from across the room is a regression, whatever else it improves.
- **Server binds localhost only.** `127.0.0.1`, the effective port (`8686` by
  default or `HERDR_MISE_PORT`), and its origin policy are security boundaries,
  not defaults to loosen.
- Keep diffs small and root-caused; a fix in the shared path beats guards in
  every caller.

## Reporting bugs

Use the [bug report template](https://github.com/funsaized/herdr-mise/issues/new?template=bug_report.md).
Provide either a deterministic playground preset URL or sanitized, fictional
reproduction data—never private Herdr data.

For security issues, see [SECURITY.md](SECURITY.md) instead.
