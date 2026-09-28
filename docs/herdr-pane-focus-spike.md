# Herdr pane focus: source-backed feasibility spike (not implemented)

**Decision: no-go for product focus or a live focus experiment yet.** The pinned
source exposes `pane.focus`; this is not a request for a missing method. It is
not a read operation. Issue acceptance and this source review are **not** human
approval to send a focus request. Today's TUI selection / `b` navigation and
browser Copy locator remain local; Mise sends no focus requests.

## Immutable upstream evidence

The five commits below are the supported pins in
[`compatibility/herdr.json`](../compatibility/herdr.json). Each linked schema
defines `PaneFocus(PaneTarget)`; dispatch invokes `handle_pane_focus`; the
handler parses the target, focuses its workspace/tab/pane, marks the active tab
seen, and returns `PaneInfo` (or `pane_not_found` for an unresolved target).
The linked identifier parser checks moved-pane aliases before native public
identifiers. These are source observations, **not live validation**.

| Protocol / immutable commit                     | Schema (`PaneFocus`; `PaneTarget` is a string `pane_id`)                                                                                                                                                                                                | Dispatch                                                                                                       | Handler                                                                                                                    | Identifier resolution                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 17 / `ef4c23f5775bb8cfec05f05d0844226ff959a07a` | [schema.rs](https://github.com/herdrdev/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/api/schema.rs#L160-L161), [common.rs](https://github.com/herdrdev/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/api/schema/common.rs)         | [api.rs](https://github.com/herdrdev/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/app/api.rs#L1044) | [panes.rs](https://github.com/herdrdev/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/app/api/panes.rs#L158-L174) | [ids.rs](https://github.com/herdrdev/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/app/ids.rs#L95-L143) |
| 19 / `346411fa21afd297f5ed3b3fa56f9e3fbf7654b7` | [schema.rs](https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/api/schema.rs#L162-L163), [common.rs](https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/api/schema/common.rs)         | [api.rs](https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/app/api.rs#L1069) | [panes.rs](https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/app/api/panes.rs#L161-L177) | [ids.rs](https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/app/ids.rs)          |
| 20 / `9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c` | [schema.rs](https://github.com/herdrdev/herdr/blob/9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c/src/api/schema.rs#L162-L163), [common.rs](https://github.com/herdrdev/herdr/blob/9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c/src/api/schema/common.rs)         | [api.rs](https://github.com/herdrdev/herdr/blob/9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c/src/app/api.rs#L1105) | [panes.rs](https://github.com/herdrdev/herdr/blob/9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c/src/app/api/panes.rs#L168-L184) | [ids.rs](https://github.com/herdrdev/herdr/blob/9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c/src/app/ids.rs)          |
| 21 / `98307c509e9688575d006b47d26d0db561cda0a4` | [schema.rs](https://github.com/herdrdev/herdr/blob/98307c509e9688575d006b47d26d0db561cda0a4/src/api/schema.rs#L180-L181), [common.rs](https://github.com/herdrdev/herdr/blob/98307c509e9688575d006b47d26d0db561cda0a4/src/api/schema/common.rs)         | [api.rs](https://github.com/herdrdev/herdr/blob/98307c509e9688575d006b47d26d0db561cda0a4/src/app/api.rs#L973)  | [panes.rs](https://github.com/herdrdev/herdr/blob/98307c509e9688575d006b47d26d0db561cda0a4/src/app/api/panes.rs#L468-L484) | [ids.rs](https://github.com/herdrdev/herdr/blob/98307c509e9688575d006b47d26d0db561cda0a4/src/app/ids.rs)          |
| 22 / `b99002ac99b09e00b4ca692436cb15a6b0d676f1` | [schema.rs](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/api/schema.rs#L182-L183), [common.rs](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/api/schema/common.rs#L33-L36) | [api.rs](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/api.rs#L1119) | [panes.rs](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/api/panes.rs#L468-L484) | [ids.rs](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/ids.rs#L95-L143) |

The existing Herdr request envelope is newline-delimited JSON with an `id`,
`method`, and `params`. A proposed request would use `method: "pane.focus"` and
`params: {"pane_id": <current snapshot AgentInfo.pane_id>}`; the snapshot
`AgentInfo.pane_id` uses the same [public_pane_id producer](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/ids.rs#L27-L38).
The handler does not inject PTY input, but switching focus changes the active
workspace/tab/pane and seen state; subsequent physical keyboard input goes to
the newly focused terminal. This is a non-read side effect.

## Target safety is not established for a command boundary

Alias-first parsing is real: a colliding alias would win over a current public
identifier. Pinned [raw-alias shadow cleanup](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/state.rs#L899-L901)
removes raw-id aliases when a new pane ID shadows them. Public aliases created on
[cross-workspace moves](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/api/panes.rs#L1138-L1140)
are not removed by that cleanup. Current upstream public-number
[registration and removal](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/workspace.rs#L1147-L1154),
[non-reuse test](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/workspace.rs#L1478-L1496),
and [workspace-id reservation](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/workspace.rs#L151-L173)
support non-reuse of public locators: no reused-native-locator collision is
established by the pinned source. But `pane.focus` accepts a stale moved-pane
alias whereas the upstream [current-public-id resolver](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/ids.rs#L145-L151)
rejects one for agent targeting. These invariants do not supply an atomic
terminal-identity guard for `pane.focus`, nor a behavioral test across a
snapshot-to-request race. A preflight lookup can go stale; comparing returned
`PaneInfo` only detects a wrong target **after** focus has changed. The
checked-in fixture uses fictional identifiers, not a live Herdr parse/focus
test. No focus request was sent and no supported protocol was added.

**Upstream request draft (not posted):** Please add a focus operation accepting
an expected stable `terminal_id` (or an atomic `expected_terminal_id` guard on
`pane.focus`), resolving the terminal and checking that identity in the same
operation that switches focus. On absence, movement to a different target, or
identity mismatch, return a typed no-focus error. Specify alias precedence and
public-identifier reuse guarantees across moves/restores, and test a moved
alias versus a reused public locator and a close/replacement between snapshot
and focus. This would permit safe identity targeting without name matching,
shell/CLI automation, simulated keys, or post-focus response checks.

## Gated follow-up (proposal only)

With **recorded human approval of the exact operation, target-safety decision,
and supported surfaces**, plus an upstream atomic identity guarantee (and
isolated behavioral validation), a separately reviewed TUI action
could resolve selected stable terminal identity against current live state,
then request only `pane.focus` via `server/src/adapter.rs`, the sole owner of
Herdr wire knowledge. Never accept arbitrary methods or user-provided
locators. `Feed` stays a normalized read projection; selection and next-blocked
stay local. Reject absent, ended, demo, disconnected, unsupported, or stale
targets; bound requests/responses, surface failure truthfully, and never retry
automatically after an ambiguous timeout. Keep today's inspection/help and
browser exact-locator copying available. Never approve, prompt, kill, or send
input to agents.

The browser is a separate decision: `service.rs` only serves a read feed and
static assets, not an authorized command boundary. It stays copy-only unless
a separately approved same-origin, CSRF-resistant command boundary is
specified; the present `/ws` allowance for missing Origin (CLI/tests) and
optional extra origins must not silently authorize mutation. No direct
Unix-socket browser access, deep links, or arbitrary RPC forwarding.
Trust-boundary changes require a same-repository PR authored by `@funsaized`
and managed verification on its current head. The fixture regression checks
navigation/fallback, not Herdr focus safety; an approved implementation needs
exact-request/response socket tests and isolated upstream race evidence.
