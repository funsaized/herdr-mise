# Stable acceptance contract

> Historical v0.1.0 record: this contract promoted the published `v0.1.0`
> release. A future stable release requires a new accepted RC and contract; do
> not reuse this RC1 evidence as current acceptance.

Stable publication was blocked until one evidence document passed the
fail-closed validator. BL-006 was executed against the public `v0.1.0-rc.1`
tag, its immutable commit, and its exact public artifact checksums. A separate
`promotion` block bound the stable `v0.1.0` tag/version to the exact accepted
`main` commit. No evidence row claimed to test unpublished stable assets. An
automated check could not replace a manual observation or elapsed soak.

The repository has no valid prior public version: the earlier non-TUI RC1 was
overwritten and explicitly invalidated. The accepted RC is the TUI-inclusive
replacement published from commit
`ea74ac5f95afb1052eb41d87c14c4f28d03d932b`. On 2026-08-14, before stable
acceptance began, the project explicitly replaced the earlier non-TUI RC1 tag
and all six assets. The previous RC1 commit and checksums are invalid acceptance
inputs. Anyone who downloaded RC1 before that date must download it again and
verify the current sidecar. This one-time replacement is recorded here because
silently treating the old and new bytes as the same candidate would be false.

## Evidence and exact validation

Start from `docs/stable-acceptance.template.json`; it explicitly names public RC
`v0.1.0-rc.1`, its tag commit, and the three exact published archive checksums.
Only its promotion-commit value is a sentinel. Every row deliberately remains
`NOT_RUN`. Replace the promotion commit with the reviewed stable-version `main`
commit. Keep completed evidence outside the repository. Never record agent
names, workspace names or paths, home paths, credentials, or Herdr payloads:
live logs record only mode, agent count, source status, and recovery state.

The template binds all three supported public RC archives and their published
sidecar checksums:

- `aarch64-apple-darwin`: `aadf2ceaafbd93a10309d02c152b9fce5dc1f19fecd1f71ec757ea745e91b52c`
- `x86_64-apple-darwin`: `4dcfb2f3768cb89d848ebf780bc5418c6c17bb731fc0aae9b4d13a386649dba8`
- `x86_64-unknown-linux-gnu`: `057a1302c082e552955e13da93d470fb71e9a11612a77f114bd0aabc003ed2bf`

Verify each sidecar and archive anonymously before changing `public-artifact`
from `NOT_RUN`. A platform-specific row may reference one or more of this exact
top-level allowlist; it may never name an unpublished stable archive.

Run the release layers independently:

```sh
npm run validate:release
npm run perf
sh scripts/verify-public-artifact.sh \
  https://github.com/funsaized/herdr-mise/releases/download/v0.1.0-rc.1/herdr-mise-v0.1.0-rc.1-aarch64-apple-darwin.tar.gz \
  https://github.com/funsaized/herdr-mise/releases/download/v0.1.0-rc.1/herdr-mise-v0.1.0-rc.1-aarch64-apple-darwin.tar.gz.sha256 \
  0.1.0-rc.1
node scripts/validate-acceptance-evidence.mjs --evidence /absolute/external/evidence.json \
  --promotion-tag v0.1.0 --promotion-version 0.1.0 \
  --promotion-commit 0123456789abcdef0123456789abcdef01234567
```

The artifact command downloads anonymously (curl configuration and netrc are
disabled), verifies checksum and
exact three-file archive shape, runs the packaged smoke verifier, and installs to
a new version directory. With no install root it uses a new temporary root. For
the first-release `upgrade` gate, install a verifier-owned prior fixture into an
isolated install root, then use the production public-artifact verifier to stage
the exact accepted public RC in that same root using the procedure below. PASS
requires `current` to transition to the accepted RC, the exact RC checksum and
path, the fixture to remain available for rollback, no temporary selector at
`INSTALL_ROOT/herdr-mise/current.next`, and a successful launch from `current`.
This checks first-release installer transition and rollback mechanics; it does
not prove an upgrade from a prior public release.
To test clean uninstall, first select a different current version, then run
`sh scripts/uninstall-acceptance-artifact.sh INSTALL_ROOT VERSION`. The command
refuses to remove the selected version or anything lacking verifier metadata.

### First-release fixture-to-RC procedure

Run this macOS arm64 procedure from the repository root. It creates a disposable
three-member fixture, installs it through the verifier's test-only `file://`
escape hatch, then invokes the production verifier over HTTPS for the exact
accepted RC in the same isolated root. The escape-hatch variables apply only to
the fixture command.

```sh
set -e
fixture_work=$(mktemp -d "${TMPDIR:-/tmp}/herdr-mise-first-release.XXXXXX")
fixture_stage="$fixture_work/stage"
INSTALL_ROOT="$fixture_work/install"
mkdir -p "$fixture_stage"
printf '%s\n' '#!/bin/sh' 'echo verifier-owned-fixture' >"$fixture_stage/herdr-mise"
chmod 755 "$fixture_stage/herdr-mise"
printf '%s\n' 'fixture license' >"$fixture_stage/LICENSE"
printf '%s\n' 'fixture notices' >"$fixture_stage/THIRD_PARTY_NOTICES.txt"
fixture_archive="$fixture_work/herdr-mise-v0.0.0-fixture.1-test.tar.gz"
tar -C "$fixture_stage" -czf "$fixture_archive" \
  herdr-mise LICENSE THIRD_PARTY_NOTICES.txt
if command -v sha256sum >/dev/null 2>&1; then
  fixture_sha=$(sha256sum "$fixture_archive" | awk '{print $1}')
else
  fixture_sha=$(shasum -a 256 "$fixture_archive" | awk '{print $1}')
fi
printf '%s  %s\n' "$fixture_sha" "${fixture_archive##*/}" \
  >"$fixture_archive.sha256"
ACCEPTANCE_ALLOW_FILE_URLS=1 ACCEPTANCE_SKIP_SMOKE=1 \
  sh scripts/verify-public-artifact.sh \
  "file://$fixture_archive" "file://$fixture_archive.sha256" \
  0.0.0-fixture.1 "$INSTALL_ROOT"
sh scripts/verify-public-artifact.sh \
  https://github.com/funsaized/herdr-mise/releases/download/v0.1.0-rc.1/herdr-mise-v0.1.0-rc.1-aarch64-apple-darwin.tar.gz \
  https://github.com/funsaized/herdr-mise/releases/download/v0.1.0-rc.1/herdr-mise-v0.1.0-rc.1-aarch64-apple-darwin.tar.gz.sha256 \
  0.1.0-rc.1 "$INSTALL_ROOT"
test "$(readlink "$INSTALL_ROOT/herdr-mise/current")" = 0.1.0-rc.1
test "$(cat "$INSTALL_ROOT/herdr-mise/0.1.0-rc.1/artifact-sha256")" = \
  aadf2ceaafbd93a10309d02c152b9fce5dc1f19fecd1f71ec757ea745e91b52c
test -x "$INSTALL_ROOT/herdr-mise/0.0.0-fixture.1/bin/herdr-mise"
test ! -e "$INSTALL_ROOT/herdr-mise/current.next"
test ! -L "$INSTALL_ROOT/herdr-mise/current.next"
"$INSTALL_ROOT/herdr-mise/current/bin/herdr-mise" --tui
```

The final command is the bounded manual launch check: confirm the first render,
then press `q`. Do not launch the default server for this gate; it could hang the
procedure or collide with the retained dogfood listener.

Retain `INSTALL_ROOT` and the two verifier outputs with the sanitized external
gate evidence so the fixture remains available for rollback and the accepted
RC checksum and installed path can be compared with the checked-in identity.

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

The first-release product also includes the native terminal UI. Run
`cargo test --locked tui --lib` at the accepted RC commit and record it under
`tui-test-suite`. This covers responsive layout selection, state semantics,
render goldens, bounded particles, and terminal cleanup. It does not replace the
public-artifact terminal journey below.

## Exact manual matrix

Every row begins `NOT_RUN`. The tester replaces the sentinel timestamp only after
performing the action against the exact accepted RC artifact referenced by that
row and records a sanitized external evidence reference. The row's
`executed_against` block must copy the top-level accepted RC identity and artifact.

VoiceOver speech/focus listening is deferred from the v0.1.0 release gate by the
owner's 2026-08-27 decision. It is not recorded as `PASS`; the checklist remains
in `docs/operations.md` for post-release completion.

| Gate                              | Exact action and PASS condition                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI responsive terminal           | Launch the installed accepted public RC with `--tui`; exercise `111×48 → 56×48 → 111×48`, then quit with `q`. PASS only if tiled, compact, and restored tiled layouts render without stale cells, the UI remains responsive, and terminal state is restored cleanly without disturbing another Herdr service.                                      |
| Keyboard                          | With VoiceOver off, use Tab/Shift-Tab through visible controls, arrow keys through all stations, Enter/Space to open details, and Escape to close details/settings. PASS only if focus is always visible, order is logical, every station is reachable, and focus returns to its trigger.                                                          |
| Runtime reduced motion            | Start with Reduce Motion off while a blocked scene is active; enable it in System Settings without reloading, then disable it. PASS only if continuous/particle/sweep motion stops promptly, state indicators remain legible, and motion resumes without stale or duplicate state.                                                                 |
| Blocked recognition at two meters | At a measured distance of at least two meters on the supported display, compare a blocked station with working and idle stations in both light and dinner themes. PASS only if the blocked station and blocked count are correctly identified without relying on animation or sound.                                                               |
| Upgrade                           | Run the exact first-release fixture-to-RC procedure above. PASS only if `current` transitions to the accepted RC, its exact checksum and path match, the fixture remains available for rollback, `INSTALL_ROOT/herdr-mise/current.next` is absent, and launch succeeds from `current`. This does not prove an upgrade from a prior public release. |
| Uninstall                         | Stop the accepted RC, select a different current version if needed, run the exact uninstall command, and inspect the versioned path plus running processes. PASS only if that RC version is absent, no RC process remains, and unrelated versions/data remain.                                                                                     |

## Multi-day public-RC soak

The orchestrator owns the persistent install and state directory outside the
repository. A source build cannot count.

```sh
sh scripts/acceptance-soak.sh start /absolute/external/soak-state \
  /absolute/versioned/install/herdr-mise/0.1.0-rc.1/bin/herdr-mise 72
sh scripts/acceptance-soak.sh status /absolute/external/soak-state
sh scripts/acceptance-soak.sh stop /absolute/external/soak-state
```

`start` requires the anonymous verifier's checksum/source metadata, records one
PID and its exact command, and writes logs outside the repository. Each `status`
appends a UTC review timestamp. `stop` signals only the recorded PID after command
identity validation; it never performs a broad process kill. PASS requires the
full configured duration, periodic timestamped reviews, clean recovery behavior,
and no unresolved error in the external log. Starting and stopping only proves
tool reversibility, not the time gate.
