# Stable acceptance contract

Stable publication is blocked until one evidence document passes the fail-closed
validator. BL-006 is executed against the public `v0.1.0-rc.1` tag, its immutable
commit, and its exact public artifact checksums. A separate `promotion` block
binds the future stable `v0.1.0` tag/version to the exact accepted `main` commit.
No evidence row claims to test unpublished stable assets. An automated check
cannot replace a manual observation or elapsed soak.

The accepted RC is the TUI-inclusive replacement published from commit
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
a new version directory. With no install root it uses a new temporary root. To
stage an upgrade, pass the same explicit user-owned root for old and new versions;
the `current` link selects the new version and the old version remains for rollback.
To test clean uninstall, first select a different current version, then run
`sh scripts/uninstall-acceptance-artifact.sh INSTALL_ROOT VERSION`. The command
refuses to remove the selected version or anything lacking verifier metadata.

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

| Gate                              | Exact action and PASS condition                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI responsive terminal           | Launch the installed accepted public RC with `--tui`; exercise `111×48 → 56×48 → 111×48`, then quit with `q`. PASS only if tiled, compact, and restored tiled layouts render without stale cells, the UI remains responsive, and terminal state is restored cleanly without disturbing another Herdr service. |
| Keyboard                          | With VoiceOver off, use Tab/Shift-Tab through visible controls, arrow keys through all stations, Enter/Space to open details, and Escape to close details/settings. PASS only if focus is always visible, order is logical, every station is reachable, and focus returns to its trigger.                     |
| VoiceOver speech/focus            | On macOS VoiceOver, traverse status, controls, each station, details, settings, disconnect, and empty states. PASS only after listening confirms name/role/state/value are correct, announcements are neither missing nor duplicated, and spoken focus matches visual focus.                                  |
| Runtime reduced motion            | Start with Reduce Motion off while a blocked scene is active; enable it in System Settings without reloading, then disable it. PASS only if continuous/particle/sweep motion stops promptly, state indicators remain legible, and motion resumes without stale or duplicate state.                            |
| Blocked recognition at two meters | At a measured distance of at least two meters on the supported display, compare a blocked station with working and idle stations in both light and dinner themes. PASS only if the blocked station and blocked count are correctly identified without relying on animation or sound.                          |
| Upgrade                           | Install the prior public version, start it, then use the verifier with the same install root to stage the accepted RC and select `current`; restart from `current`. PASS only if the accepted RC launches, settings remain valid, the old version remains rollback-capable, and checksum/path match evidence. |
| Uninstall                         | Stop the accepted RC, select a different current version if needed, run the exact uninstall command, and inspect the versioned path plus running processes. PASS only if that RC version is absent, no RC process remains, and unrelated versions/data remain.                                                |

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
