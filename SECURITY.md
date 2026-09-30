# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub security advisories](https://github.com/funsaized/herdr-mise/security/advisories/new)
rather than a public issue. Expect an acknowledgment within a week.

## Scope and threat model

herdr-mise is a localhost-only, read-only visualizer:

- The server binds `127.0.0.1` exclusively and never listens on external
  interfaces. `HERDR_MISE_PORT` is a port-only operator control; it defaults to
  `8686` and fails closed on invalid or unavailable values.
- WebSocket upgrades enforce an origin allowlist for the effective listener
  port (or explicitly configured `HERDR_MISE_EXTRA_ORIGINS`); foreign origins
  receive 403.
- The binary reads one local Unix socket (herdr) and serves embedded static
  assets; it executes nothing, writes nothing outside its own process, and
  sends no telemetry.
- The UI displays agent names, workspace paths, and states from the local
  feed. Anything that could leak that feed off-host, bypass the origin
  policy, execute content from the feed, or bind beyond localhost is in
  scope and taken seriously.

Vulnerabilities in the agents being visualized, or in herdr itself, are out
of scope here — report those upstream.

## Proposed exception (not implemented or approved)

[The pane-focus spike](docs/herdr-pane-focus-spike.md) describes a possible
explicit TUI-only `pane.focus` action. Today's runtime is still read-only.
Focus switches the workspace/tab/pane, marks the tab seen, and routes later
physical keystrokes to that pane even though the request itself sends no PTY
input. Pane locators in the feed are untrusted, mutable data: aliases, movement,
stale snapshots and close/replacement races make a preflight or post-response
check insufficient to prevent mis-focus. A future action must target a verified
stable terminal identity atomically, reject unavailable targets, bound requests
and responses, and avoid automatic retries on ambiguous timeouts. It must
never approve, prompt, kill, or send input to agents.

Before implementation **or any live focus experiment**, require recorded human
approval of the exact operation, target-safety evidence/decision, and supported
surfaces. Issue acceptance is not that approval. The browser remains copy-only:
its read WebSocket Origin rules (including missing Origin and optional extra
origins) cannot authorize commands; a separate same-origin CSRF-resistant
boundary would need separate approval. Trust-boundary changes must pass managed
verification on the current head of a same-repository pull request authored by
`@funsaized`.

## Supported versions

Only the newest stable release, identified by [GitHub Latest](https://github.com/funsaized/herdr-mise/releases/latest), is supported. Prereleases
are evaluation builds and receive fixes only when explicitly identified as
supported in their release notes.
