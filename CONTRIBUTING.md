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
npm run bundle        # builds the client and the release binary
```

Client-only iteration needs no Rust at all:

```sh
npm run dev:visual    # isolated playground on http://localhost:8686
```

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

Open a GitHub issue with what you saw, what you expected, and — if it's a
feed/rendering problem — the output of the browser console and, when relevant,
a `?preset=…` playground URL that reproduces it.

For security issues, see [SECURITY.md](SECURITY.md) instead.
