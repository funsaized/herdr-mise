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
