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

| Acceptance                                                           | State                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native source, symlink and known-credential checks                   | PASS, both roles                                                                                                                                                                                                                                                     |
| Backend unavailable fails before launch                              | PASS                                                                                                                                                                                                                                                                 |
| Real provider startup and parsed result                              | PASS: OpenCode `reviewer`, resolved `xai/grok-4.6`, exit 0 and parsed JSON                                                                                                                                                                                           |
| Representative actor edits and tests                                 | PASS: real OpenCode builder created a Node test in a sibling checkout and reported exit 0; independent file inspection and rerun passed. Repository npm installs, TypeScript/build, 124 Node, 221 client and 147 Rust library tests now pass under the actor profile |
| Inherited sockets and credential-broker coverage                     | PASS for extra descriptor closure, advertised SSH/GPG endpoint removal, known-path Unix agent denial, and an explicit dummy-keychain read; arbitrary broker isolation is not claimed                                                                                 |
| Native executor cancellation/timeout and ordinary descendant cleanup | PASS: six installed-release probes across both roles; shared-server cancellation is blocked; see [known limits](limits.md#shared-server-cancellation)                                                                                                                |
| Complete home isolation / exclusive scratch / restricted egress      | Not implemented; explicit local-mode limits                                                                                                                                                                                                                          |

The approved `@funsaized/cli-agent@2026.09.20.1` release closes the observed
ordinary-child leak after early provider exit and propagates optional caller
cancellation through execution and retry backoff. All six native probes against
the installed release passed with zero surviving fixture processes:
[recorded observations](evidence/worker-lifecycle.json).
The shared source suite passes 220 tests with one existing Linux-only skip.
This covers the actual executor with supplied abort signals; it does not prove
that every Swamp runtime/cancellation route supplies that signal. Children that
create another process group/session remain outside this cleanup guarantee.

ENG-007 remains open until the outstanding acceptance cases are resolved. Keep
one planner, two builders or seven review lanes, with major phases mutually
exclusive in a checkout. Metadata-only intake may overlap using the same server.

Direct local runtime cancellation passes, but local cancellation of a server-owned
run kills the shared server and can leave a child alive. See the
[confirmed runtime limitation](limits.md#shared-server-cancellation).

## Socket acceptance and local-mode limits

Native probes found that the generic executor inherited an explicitly supplied
Unix socket, and file-read denial alone permitted a new connection to a dummy
credential-agent socket. The Mac `invoke_nightshift` route now uses a trusted
[OpenCode launcher](../../scripts/nightshift-opencode.py) that closes descriptors
above stderr before exec and removes `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, and
`GPG_AGENT_INFO`. It requires `opencode` on the trusted PATH and rejects a
symlinked launcher. `/usr/bin/python3` is required on the Mac host.

Both role profiles deny outbound Unix connections under known SSH, GPG,
1Password and macOS launchd-agent paths. Provider IP traffic and ordinary
application/test sockets remain allowed. A blanket Unix-socket restriction was
rejected because it prevented legitimate Herdr adapter tests from completing.

The [repeatable acceptance probes](../../scripts/worker-acceptance/README.md)
pass against the final policy. A real OpenCode reviewer (`xai/grok-4.6`) also
returned parsed JSON through the new launcher. [Sanitized observations](evidence/worker-capabilities.json)
bind the tested subject and policy/launcher bytes. The generic shared CLI-agent
executor has not gained descriptor closure; this guarantee belongs to the
Nightshift Mac route.

The keychain check uses an explicitly named disposable keychain, with an
unsandboxed positive control. It does not certify every Mach service or credential
broker. Custom broker sockets outside the known denied paths remain reachable,
and other inherited provider environment credentials remain available to tools.
Ordinary HOME reads, shared scratch/provider state and unrestricted provider
networking remain intentional local-mode limits. No concurrency increase follows
from these results.
