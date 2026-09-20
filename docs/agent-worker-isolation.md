# Agent worker isolation decision

Status: macOS Seatbelt selected by the maintainer on 2026-09-20. Native
filesystem canaries pass; the full deployment acceptance matrix remains open.
Applies to engineering backlog ENG-007, not the localhost application's runtime.
Linux VMs are no longer a prerequisite for this rollout.

## Current execution boundary

Nightshift planning, review and building use the existing CLI-agent integration
through `invoke_nightshift`. On macOS the adapter requires Seatbelt, resolves the
role profile from the orchestrator repository rather than the agent subject, and
runs native canaries before launching the provider. Missing policies, symlinked
policies, missing sandbox backend, and failed canaries prevent agent launch.
The installed integration still owns provider execution, environment filtering,
timeouts, output parsing and invocation records. Linux keeps mandatory automatic
backend selection; Linux CI is not evidence of macOS enforcement.

The macOS route currently supports OpenCode. Read-only roles deny source writes
at the OS boundary, including writes through symlinks. Actors can edit their
subject checkout. Both profiles deny direct access to known unrelated credential
files, Swamp credentials and the login keychain. Only the selected provider's
file-backed login is allowed, including OAuth refresh writes. Writes elsewhere
are denied except temporary storage and the documented OpenCode state/cache
paths. Repository-local `.swamp/secrets` remains denied.

This is a local process sandbox, not a disposable VM or full home-directory
isolation. Ordinary home files remain readable. Provider network access is
allowed; there is no provider-only egress filter. Temporary storage and provider
state are shared. A provider credential visible to its CLI is also visible to
its tools. Keychain file denial does not attest denial of every credential
broker or Mach service. These limits preclude a claim that arbitrary hostile
code is fully isolated from the maintainer account.

The trusted launcher and its policies must not be editable by an actor. Builders
use separate subject workspaces. The adapter rejects a launcher checkout in
shared temporary or provider storage writable by the actor profile. Changing the launcher checkout during a run is
prohibited by the existing checkout exclusions. Managed owner-dispatched review
still applies to policy changes; an unmerged subject cannot grant itself a new
profile. No concurrency expansion is authorized by passing these canaries.

## Evidence and remaining acceptance

`check_macos_sandbox` extends `@funsaized/cli-agent`. It uses the installed
`wrapWithSandbox` launch function with disposable fixture HOME/source paths,
not a simulated sandbox or a provider's self-report. It stores policy SHA-256s,
timestamps, named observations and limits in `macosSandboxProbe` resources.
No real credentials are read by the probe. Fixture cleanup runs on success and
failure. This proves the tested filesystem rules, not full invocation teardown.

On 2026-09-20 all twenty native checks passed on the maintainer Mac: source
readability, role-appropriate source writes, symlink writes, SSH denial, login
keychain denial rename/deletion, selected-provider login access, a real Node test and failure for a missing backend, each for both roles. The
native regression test repeats these checks; Linux explicitly skips it. The
profile resolver also rejects symlinked policies.

The installed `checkFactoryViability` method is hard-coded to `bwrap`; it cannot
certify this macOS route. Do not run it on the Mac and interpret failure as a
requirement to provision Linux. Installed source imports are resolved at execution
time from Swamp's restored CLI-agent extension, so clean subject checkouts do not
need a copy of runtime extension files just to load the test suite.

| Acceptance                                                      | State                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native source, symlink and known-credential checks              | PASS, both roles                                                                                                                                                                      |
| Backend unavailable fails before launch                         | PASS                                                                                                                                                                                  |
| Real provider startup and parsed result                         | PASS: OpenCode `reviewer`, resolved `xai/grok-4.6`, exit 0 and parsed JSON                                                                                                            |
| Representative actor edits and tests                            | PASS: real OpenCode builder created a Node test in a sibling checkout and reported exit 0; independent file inspection and rerun passed. Full repository toolchain acceptance pending |
| Inherited sockets and credential-broker coverage                | Pending                                                                                                                                                                               |
| Cancellation/timeout and descendant cleanup                     | Pending                                                                                                                                                                               |
| Complete home isolation / exclusive scratch / restricted egress | Not implemented; explicit local-mode limits                                                                                                                                           |

ENG-007 remains open until the outstanding acceptance cases are resolved. Keep
one planner, two builders or seven review lanes, with major phases mutually
exclusive in a checkout. Metadata-only intake may overlap using the same server.
