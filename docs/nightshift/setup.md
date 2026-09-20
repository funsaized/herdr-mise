# How to set up Nightshift on macOS

Use a trusted control checkout outside shared temporary/provider storage and
separate sibling workspaces for builders. You need Git, Node/npm, the repository
Rust toolchain, Swamp, authenticated GitHub access, and OpenCode with working
provider credentials. Keep ordinary product setup in [CONTRIBUTING](../../CONTRIBUTING.md).

## Install the reproducible runtime

```sh
npm ci
npm ci --prefix client
swamp extension install
swamp doctor extensions --json
swamp model method run nightshift-github install_local_swamp
npm run swamp:local -- --version
npm run with:swamp-local -- npm run test:factory
```

The GitHub model installs the Mac binary pinned in
[`verification/swamp-local-runtime.json`](../../verification/swamp-local-runtime.json).
The launcher verifies size and SHA-256 on every use and propagates its PATH to
child commands. Missing, altered, or symlinked binaries fail; there is no fallback
to the global CLI. Each control checkout needs its own ignored `.tools/` install.
The global Swamp installation is unchanged.

The tested pin is `20260904.044433.0-sha.ab26e35b`. The newer CLI
`20260918.211634.0-sha.bcaa9695` rejects deferred template expressions during
cloning. This local pin is a compatibility path, not an upstream fix.

## Check the provider route

```sh
opencode debug agent plan
opencode debug agent build
opencode debug agent reviewer
```

Nightshift uses these machine-global agents. Their model, variant, prompt,
permissions, and tools are authoritative; a missing agent fails instead of falling
back. Planning and review need the `skill` tool to load repository skills.
The reviewer must deny source mutation. Ordinary prompts use the workflow-selected
agent; an explicit OpenCode slash command uses its configured agent.

The mandatory `invoke_nightshift` adapter applies trusted macOS Seatbelt policies
and runs native canaries before provider launch. See [the worker boundary](worker-isolation.md)
before treating this host as isolated. Linux workers are not required for this
Mac rollout; hosted Linux verification remains a separate CI control.

## Start one authenticated server

Mint a token once, then start the server in its own terminal:

```sh
npm run swamp:local -- access token mint nightshift-orchestrator \
  --principal user:nightshift-orchestrator
SWAMP_SERVE_ADMIN=user:nightshift-orchestrator \
  npm run with:swamp-local -- npm run orchestrator:serve
```

The server binds to loopback, port 9090 by default, with token authentication.
`SWAMP_SERVE_PORT` changes the port. Use one server per checkout. Provisioning a
binary does not replace a running server; finish active work before switching
runtimes. See the [cancellation limitation](limits.md#shared-server-cancellation).

In each client terminal, connect to that same server without printing its token:

```sh
export SWAMP_SERVE_URL=ws://127.0.0.1:9090
export SWAMP_SERVER_TOKEN="$(npm run --silent swamp:local -- access token reveal nightshift-orchestrator -y --json | jq -er .token)"
```

Submit all factory workflows through this connection. Do not mix local and remote
runners against the checkout. The server provides execution and locks; an active
driver still has to select work and advance its state machine.
