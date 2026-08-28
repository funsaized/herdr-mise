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
- `docs/backlog.md` — the originating initial-RC audit backlog, retained for its
  evidence, sequencing, acceptance criteria, and item-specific verification;
  it is not a second live roadmap.
- `README.md` — product behavior, deliberate boundaries, installation, and
  current verification commands. Code plus passing tests wins when prose and
  behavior disagree.
- Do not treat the audit backlog, old branches, or commit history as the current
  roadmap.

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

Use narrow checks while developing. When the branch is next to merge, sync it
with current `origin/main`, commit the final tree, then run the local verification
workflow for that exact commit:

```sh
swamp workflow validate local-verification
swamp workflow run local-verification --input commit=$(git rev-parse HEAD)
```

The workflow fetches `origin/main` and fails before dependency installation when
that remote commit is not an ancestor of the supplied commit. It never merges or
rebases the source branch. After a successful run, do not change the source
commit before pushing; any new commit requires new evidence.

See [Local verification and the remote CI gate](docs/local-verification.md) for
the controls, trust boundary, and shadow-CI migration policy.

Run `npm run format` to apply the repository's deterministic Oxfmt formatting
before checking it with `npm run format:check`.

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
