# Contributing to herdr-mise

Thanks for looking under the hood. This is a small project with strong
opinions; the docs below will save you time.

## Orientation

- `docs/architecture.md` — how the pieces fit (Rust server, TypeScript client,
  versioned protocol).
- `docs/operations.md` — how to run, develop, and verify locally.
- `README.md` — product behavior, deliberate boundaries, installation, and
  current verification commands. Code plus passing tests wins when prose and
  behavior disagree.
- GitHub issues — accepted bugs and planned work. Do not treat old branches or
  commit history as the current roadmap.

## Setup

```sh
npm ci
npm ci --prefix client
npm run bundle        # builds the client and the release binary
```

Client-only iteration needs no Rust at all:

```sh
npm run dev:visual    # isolated playground on http://localhost:8686
```

## Before you open a PR

Run the same gates CI runs:

```sh
cargo fmt --all --check && cargo test --workspace --locked
npm run typecheck && npm run lint && npm test
npm run test:visual   # Playwright browser matrix (Chromium required)
npm run audit:tokens && npm run audit:accessibility && npm run check:bundle
```

Ground rules that reviews will enforce:

- **Truthfulness over polish.** The UI never invents data. Metrics the feed
  doesn't carry render as `Unavailable`, not as plausible numbers.
- **Performance is a feature.** Bundle, wire-rate, idle-CPU, and hidden-tab
  budgets are tested; changes that regress them need a measured justification.
- **The blocked state is sacred.** Anything that makes a blocked agent less
  obvious from across the room is a regression, whatever else it improves.
- **Server binds localhost only.** `127.0.0.1:8686` and the origin policy are
  security boundaries, not defaults to loosen.
- Keep diffs small and root-caused; a fix in the shared path beats guards in
  every caller.

## Reporting bugs

Open a GitHub issue with what you saw, what you expected, and — if it's a
feed/rendering problem — the output of the browser console and, when relevant,
a `?preset=…` playground URL that reproduces it.

For security issues, see [SECURITY.md](SECURITY.md) instead.
