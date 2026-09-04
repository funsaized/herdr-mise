# Stable acceptance contract

Stable publication is blocked until one evidence document passes the fail-closed
validator. BL-006-style acceptance runs against the public `v0.2.0-rc.1` tag, its
immutable commit, and its exact public artifact checksums. A separate `promotion`
block binds the stable `v0.2.0` tag/version to the exact accepted `main` commit.
No evidence row claims to test unpublished stable assets. An automated check
cannot replace a manual observation.

The repository already has a valid prior public version: the stable `v0.1.0`
release. The upgrade gate is therefore a real installer upgrade from the public
`v0.1.0` archive to the accepted public `v0.2.0-rc.1` archive with rollback, not
a synthetic first-release fixture.

## Evidence and exact validation

Start from `docs/stable-acceptance.template.json`; it explicitly names public RC
`v0.2.0-rc.1`, its tag commit, and the three exact published archive checksums.
Only its promotion-commit value is a sentinel. Every row deliberately remains
`NOT_RUN`. Replace the promotion commit with the reviewed stable-version `main`
commit. Keep completed evidence outside the repository. Never record agent
names, workspace names or paths, home paths, credentials, or Herdr payloads:
live logs record only mode, agent count, source status, and recovery state.

The template binds all three supported public RC archives and their published
sidecar checksums:

- `aarch64-apple-darwin`: `e4cf8c06845a8fe764042b38816004aa4e23e5abed209f2245ea3b00ec2b9b57`
- `x86_64-apple-darwin`: `bad9caf8073a9bfc2a580d537a22de7968a8a6e37f29f711470bf61db121faf8`
- `x86_64-unknown-linux-gnu`: `bbcb6ab7cf31216313b42692cbb9a3025cdf35e692787e2340ea13b22e116229`

Verify each sidecar and archive anonymously before changing `public-artifact`
from `NOT_RUN`. A platform-specific row may reference one or more of this exact
top-level allowlist; it may never name an unpublished stable archive.

Run the release layers independently:

```sh
npm run validate:release
npm run perf
sh scripts/verify-public-artifact.sh \
  https://github.com/funsaized/herdr-mise/releases/download/v0.2.0-rc.1/herdr-mise-v0.2.0-rc.1-aarch64-apple-darwin.tar.gz \
  https://github.com/funsaized/herdr-mise/releases/download/v0.2.0-rc.1/herdr-mise-v0.2.0-rc.1-aarch64-apple-darwin.tar.gz.sha256 \
  0.2.0-rc.1
node scripts/validate-acceptance-evidence.mjs --evidence /absolute/external/evidence.json \
  --promotion-tag v0.2.0 --promotion-version 0.2.0 \
  --promotion-commit 0123456789abcdef0123456789abcdef01234567
```

The artifact command downloads anonymously (curl configuration and netrc are
disabled), verifies checksum and exact three-file archive shape, runs the packaged
smoke verifier, and installs to a new version directory. With no install root it
uses a new temporary root.

### Public v0.1.0-to-RC upgrade procedure

The `upgrade` gate is a real upgrade from the already-published `v0.1.0` stable
release to the accepted `v0.2.0-rc.1` archive. Install the public `v0.1.0`
archive and then the exact accepted public RC into the same isolated install
root, both through the production public-artifact verifier over HTTPS. PASS
requires `current` to transition to the accepted RC, the exact RC checksum and
path, the prior public `v0.1.0` version to remain available for rollback, no
temporary selector at `INSTALL_ROOT/herdr-mise/current.next`, and a successful
launch from `current`.

Run this macOS arm64 procedure from the repository root:

```sh
set -e
install_root=$(mktemp -d "${TMPDIR:-/tmp}/herdr-mise-upgrade.XXXXXX")/install
mkdir -p "$install_root"
sh scripts/verify-public-artifact.sh \
  https://github.com/funsaized/herdr-mise/releases/download/v0.1.0/herdr-mise-v0.1.0-aarch64-apple-darwin.tar.gz \
  https://github.com/funsaized/herdr-mise/releases/download/v0.1.0/herdr-mise-v0.1.0-aarch64-apple-darwin.tar.gz.sha256 \
  0.1.0 "$install_root"
sh scripts/verify-public-artifact.sh \
  https://github.com/funsaized/herdr-mise/releases/download/v0.2.0-rc.1/herdr-mise-v0.2.0-rc.1-aarch64-apple-darwin.tar.gz \
  https://github.com/funsaized/herdr-mise/releases/download/v0.2.0-rc.1/herdr-mise-v0.2.0-rc.1-aarch64-apple-darwin.tar.gz.sha256 \
  0.2.0-rc.1 "$install_root"
test "$(readlink "$install_root/herdr-mise/current")" = 0.2.0-rc.1
test "$(cat "$install_root/herdr-mise/0.2.0-rc.1/artifact-sha256")" = \
  e4cf8c06845a8fe764042b38816004aa4e23e5abed209f2245ea3b00ec2b9b57
test -x "$install_root/herdr-mise/0.1.0/bin/herdr-mise"
test ! -e "$install_root/herdr-mise/current.next"
test ! -L "$install_root/herdr-mise/current.next"
"$install_root/herdr-mise/current/bin/herdr-mise" --tui
```

The final command is the bounded manual launch check: confirm the first render,
then press `q`. Do not launch the default server for this gate; it could hang the
procedure or collide with the retained dogfood listener.

To test clean uninstall, first select a different current version, then run
`sh scripts/uninstall-acceptance-artifact.sh INSTALL_ROOT VERSION`. The command
refuses to remove the selected version or anything lacking verifier metadata.

Retain `INSTALL_ROOT` and the verifier outputs with the sanitized external gate
evidence so the prior public release remains available for rollback and the
accepted RC checksum and installed path can be compared with the checked-in
identity.

## Automated product journeys

The supported-Herdr live boundary is exercised by these named Rust journeys:

```sh
cargo test --locked feed::tests::stub_socket_selects_live_mode -- --exact
cargo test --locked feed::tests::missing_source_then_live_source_replaces_demo_atomically -- --exact
cargo test --locked service::tests::source_loss_and_restore_serves_a_fresh_authoritative_snapshot -- --exact
cargo test --locked adapter::tests::protocol_19_empty_agents_ignores_ordinary_panes -- --exact
```

They cover positive live mode, startup recovery, source-loss/reconnect recovery,
and connected live mode with zero agents. Evidence summaries must contain only
`mode=live`, an agent count, `source_status`, and transition state. The deterministic
browser suite runs `npm run test:visual` and explicitly covers 1, 6, and 12 stations
in light and dinner themes. This is visual-product coverage, not live-agent proof.

The product also includes the native terminal UI. Run
`cargo test --locked tui --lib` at the accepted RC commit and record it under
`tui-test-suite`. This covers responsive layout selection, state semantics,
render goldens, bounded particles, and terminal cleanup. It does not replace the
public-artifact terminal journey below.

## Exact manual matrix

Every row begins `NOT_RUN`. The tester replaces the sentinel timestamp only after
performing the action against the exact accepted RC artifact referenced by that
row and records a sanitized external evidence reference. The row's
`executed_against` block must copy the top-level accepted RC identity and artifact.

VoiceOver speech/focus listening remains outside the v0.2.0 release gate. It is
not recorded as `PASS`; the checklist remains in `docs/operations.md` for
post-release completion.

| Gate                              | Exact action and PASS condition                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI responsive terminal           | Launch the installed accepted public RC with `--tui`; exercise `111×48 → 56×48 → 111×48`, then quit with `q`. PASS only if tiled, compact, and restored tiled layouts render without stale cells, the UI remains responsive, and terminal state is restored cleanly without disturbing another Herdr service. |
| Keyboard                          | With VoiceOver off, use Tab/Shift-Tab through visible controls, arrow keys through all stations, Enter/Space to open details, and Escape to close details/settings. PASS only if focus is always visible, order is logical, every station is reachable, and focus returns to its trigger.                     |
| Runtime reduced motion            | Start with Reduce Motion off while a blocked scene is active; enable it in System Settings without reloading, then disable it. PASS only if continuous/particle/sweep motion stops promptly, state indicators remain legible, and motion resumes without stale or duplicate state.                            |
| Blocked recognition at two meters | At a measured distance of at least two meters on the supported display, compare a blocked station with working and idle stations in both light and dinner themes. PASS only if the blocked station and blocked count are correctly identified without relying on animation or sound.                          |
| Upgrade                           | Run the exact public v0.1.0-to-RC upgrade procedure above. PASS only if `current` transitions to the accepted RC, its exact checksum and path match, the prior public v0.1.0 version remains available for rollback, `INSTALL_ROOT/herdr-mise/current.next` is absent, and launch succeeds from `current`.    |
| Uninstall                         | Stop the accepted RC, select a different current version if needed, run the exact uninstall command, and inspect the versioned path plus running processes. PASS only if that RC version is absent, no RC process remains, and unrelated versions/data remain.                                                |
