# Native Mac worker acceptance

Run from a trusted macOS control checkout with restored extensions. These are
explicit acceptance probes, not portable CI tests. They use the installed
CLI-agent executor and repository Seatbelt profiles. Python 3, Node/npm, Rust,
and Swamp's bundled Deno must already be available.

The socket and keychain probes use only owned dummy fixtures. The keychain probe
creates a temporary keychain and deletes it afterward; it never queries existing
keychain items. The descriptor probe deliberately passes socket FD 123 through
Deno into the production OpenCode launcher, substituting a dummy OpenCode binary.
It checks both descriptor closure and removal of advertised SSH/GPG endpoints.

```sh
python3 scripts/worker-acceptance/inherited-socket.py
DENO="$HOME/.swamp/deno/deno"
"$DENO" run --no-lock --node-modules-dir=none --allow-all \
  scripts/worker-acceptance/unix-broker.ts "$PWD"
"$DENO" run --no-lock --node-modules-dir=none --allow-all \
  scripts/worker-acceptance/keychain.ts "$PWD"
```

The toolchain probe installs locked npm dependencies, builds and checks the client,
and executes Node, client, and Rust library tests. Give it a **disposable subject
checkout**, never the control checkout. It writes bounded executor logs and its
JSON summary to `/tmp/nightshift-toolchain-*`; do not run two copies together.

```sh
"$DENO" run --no-lock --node-modules-dir=none --allow-all \
  scripts/worker-acceptance/toolchain.ts "$PWD" /path/to/disposable-subject
```

Record the subject commit, profile/launcher hashes, runtime identity and actual
results with any acceptance claim. The probes exit nonzero on unexpected results.
The toolchain probe is a representative compatibility check, not full managed CI,
browser/endurance acceptance, or evidence that every credential broker is denied.
A real provider startup smoke through `invoke_nightshift` remains a separate check.

## Invocation lifecycle

Restore the reviewed `@funsaized/cli-agent@2026.09.30.1` through Swamp before
native acceptance; launcher-only SIGTERM coverage cannot prove cancellation.
The adapter already forwards the execution context. Do not edit pulled files or
replace the executor with a local fork.

```sh
swamp extension pull @funsaized/cli-agent@2026.09.30.1 --yes --json
"$DENO" run --no-lock --node-modules-dir=none --allow-all \
  scripts/worker-acceptance/lifecycle.ts "$PWD"
python3 scripts/worker-acceptance/inherited-socket.py
node scripts/worker-acceptance/playwright-lifecycle.mjs
npm run test:unit -- --test-name-pattern='^nightshift launcher reaps detached listeners after provider exit$' --test-reporter=tap
npm run test:unit -- --test-name-pattern='^nightshift launcher reaps detached listeners on termination$' --test-reporter=tap
npm run test:unit -- --test-name-pattern='^nightshift launcher preserves unrelated listeners across invocations$' --test-reporter=tap
```

`lifecycle.ts` uses the checked-in detached-listener provider through installed
`runCli` and the actual readonly/actor Seatbelt profiles. Each role covers normal
completion, wall timeout and caller AbortSignal cancellation after readiness.
Timeout/cancellation listeners resist SIGTERM, requiring launcher escalation.
It asserts process absence and immediately binds every recorded socket, including
the identical primary port, at executor settlement, before emergency teardown.
It preserves the caller's original cancellation reason and checks timeout
attribution. It refuses to run if the imported executor's `CLI_AGENT_VERSION`
differs from the pin. Successful output includes sanitized results, the declared
pin, the loaded executor's version and SHA-256, and launcher/profile hashes.
Record it only after successful native execution on the control host; agent
sandboxes cannot apply a nested Seatbelt profile.

The Node selections also cover ordinary children, grandchildren, immediate and
nonzero provider exits, retained output pipes, unrelated listeners and incomplete
readiness cleanup. Live identity inspection failure or a different inspection
source is not proof of reaping. Failure teardown grants the supervisor bounded
SIGTERM grace, then escalates only owned processes and retains partial readiness
identities until cleanup finishes.

The Playwright probe uses the real runner's browser-free webServer fixture,
interrupts the provider invocation, then requires a successful second run on the
same port with `reuseExistingServer:false`. It additionally checks a bound server
with withheld provider readiness. No browser download is needed. This is direct
launcher termination coverage, not executor cancellation acceptance.

Current [observations and hashes](../../docs/nightshift/worker-isolation.md#invocation-lifecycle-304)
record a passing Playwright probe but blocked native acceptance: this execution
environment denies `ps` and nested Seatbelt application. Do not count those
failures or historical receipts as native acceptance. On the trusted host,
demonstrate the old pin's cancellation failure in an isolated restored control
checkout (not by replacing this checkout's pin), then the new pin's success.
Forced supervisor death and deliberately erased identity remain outside the
claim; ordinary supported executor paths must never bypass cleanup.
