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

## Supported versions

Only the newest stable release, currently `v0.2.0`, is supported. Prereleases
are evaluation builds and receive fixes only when explicitly identified as
supported in their release notes.
