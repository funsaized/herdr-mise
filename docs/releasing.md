# Release operations

This is the decision trail and operator runbook for release candidates and
stable releases. It does not authorize a tag or publication; the GitHub
releases page is authoritative for what has been published.

## Release decision trail

`server/Cargo.toml` is the one authoritative version source. A release tag must
be canonical SemVer with a lowercase `v` prefix and must exactly equal that
Cargo version. Build metadata is rejected. A tag with any SemVer prerelease
suffix (for example, `v0.1.0-rc.2`) is a GitHub prerelease. A tag without a
suffix (for example, `v0.1.0`) is stable.

Pull requests and manual workflow runs build and validate but never publish.
Only a matching tag can reach the publish job. Do not create a tag until the
candidate commit, notes, and acceptance record are complete. Published tags
are immutable: never move, force-update, delete-and-reuse, or otherwise reuse a
release tag.

Historical exception: on 2026-08-14, under explicit owner authorization and
before stable acceptance began, `v0.1.0-rc.1` was replaced to incorporate the
TUI into the first-release contract. The public tag now resolves to
`ea74ac5f95afb1052eb41d87c14c4f28d03d932b`; all six assets and three archive
checksums were replaced. The old non-TUI commit and assets are invalidated.
This disclosure documents an exceptional migration, not a reusable release
procedure. RC1 is frozen from this point forward.

Both release classes retain the same three platform archives and three SHA-256
sidecars, signing/notarization checks, exact-six-asset checks, rerun validation,
and anonymous public download verification. RCs are marked prerelease and are
verified not to be Latest. Stable releases are non-prereleases and must become
the public Latest release.

## Stable acceptance gate

Stable publication fails closed before release creation or upload. The
`stable_acceptance` workflow job runs only for a stable tag and is a dependency
of `publish`. Configure a protected GitHub environment named `stable-release`
with the base64-encoded, sanitized JSON record in the
`STABLE_ACCEPTANCE_EVIDENCE_BASE64` environment secret. Missing, empty,
malformed, incomplete, failing, or context-mismatched evidence blocks the job.
The validator must also emit its exact success marker; exit code zero alone is
not accepted. RC release workflows do not read this secret.

The checked-in acceptance validator owns the required BL-006 gate list and JSON
Schema. Its evidence has two deliberately separate identities:

- `accepted_rc` identifies public prerelease `v0.1.0-rc.1`, its immutable tag
  commit, and the public archive URLs and SHA-256 values actually exercised.
  Every required acceptance row repeats that RC identity and references one or
  more of those exact artifacts. Public-artifact, manual, and multi-day soak
  results therefore describe the public RC they really tested.
- `promotion` identifies the future stable tag, stable Cargo version, and exact
  accepted `main` commit. The stable workflow passes its tag/version/commit to
  the validator and requires an exact match before publication.

Stable workflow asset bytes and checksums are not acceptance inputs. In
particular, the gate never asks an unpublished stable run to prove a public
download or completed soak, and timestamped macOS signatures cannot invalidate
already-honest RC acceptance evidence.

Keep working evidence outside version control (the root local path
`.stable-acceptance-evidence.json` is ignored). The environment record must use
generic tester identities and sanitized references. It must not contain real
agent names, workspace paths, private Herdr payloads, credentials, personal
deployment identifiers, or unresolved placeholders. Never manufacture `PASS`
for a manual or elapsed-time gate.

### Supported RC-to-stable flow

1. Verify public `v0.1.0-rc.1` archives and sidecars and record their exact URLs,
   targets, checksums, and immutable RC tag commit.
   Once acceptance begins, freeze that RC release: do not rerun its tag workflow,
   replace its assets, move its tag, or otherwise change the accepted bytes.
2. Execute every BL-006 automated, manual, and elapsed multi-day soak gate
   against those installed public RC artifacts. Rows remain `NOT_RUN` or `FAIL`
   until the recorded action really passes.
3. Select and review one exact `main` commit for promotion. It must contain the
   stable Cargo version and stable release-notes template. Record that exact
   commit, stable version, and prospective stable tag in `promotion`.
4. Validate and sanitize the complete evidence record, then configure the
   protected environment secret before creating the stable tag.
5. Create the stable tag only at the accepted `main` commit. The first tag run
   validates promotion identity and complete RC acceptance before creating or
   uploading a release.

This process does not use a failed stable job to discover a digest, construct
evidence, or unlock a rerun. A rerun may only retry a transient failure with the
same already-complete inputs; it is not an evidence-generation phase.

## Stable release notes

Before a stable tag is created, check in `docs/releases/<TAG>.md`. This is the
prose template, and the workflow refuses stable creation unless it contains
these exact level-two headings:

- `Purpose`: what the release is for and its important user-visible outcome.
- `Install`: checksum-first download, extraction, and launch instructions.
- `Herdr compatibility`: the tested Herdr releases and snapshot protocols.
- `Limitations`: known constraints, including localhost/read-only behavior and
  any remaining supported-platform limits.

Do not put a `Checksums` heading or prospective stable checksum in the template.
After the signed archives exist, the same successful workflow normalizes line
endings/trailing newlines and appends `## Checksums` plus one
`<sha256><two spaces><archive filename>` line per target from the generated
sidecars. Existing stable notes are normalized before rerun comparison, avoiding
CRLF or trailing-newline-only failures while still blocking content drift. RCs
may continue to use generated notes and are always visibly marked prerelease.

## Failure recovery

Before creating the stable tag, fix candidate source, notes template, or
evidence on a new commit; select that exact commit for promotion; regenerate the
promotion block; and revalidate. A missing secret, rejected schema, promotion
mismatch, failed notarization, or incomplete notes is a safe blocked condition,
not grounds to bypass a gate or fabricate RC acceptance.

If the immutable stable tag has already been pushed and its run blocks before
release creation, do not move or reuse it and do not harvest that failed run's
artifacts to rewrite evidence. A purely transient retry may use the same complete
inputs. Any source, notes-template, promotion-commit, or acceptance correction
requires fix-forward with a new version and new tag.

If a rerun finds an existing matching release, it validates the release class,
tag, display name, and absence of unexpected assets before replacing the expected six
assets. A class mismatch or unexpected asset blocks the rerun for operator
review. Do not delete evidence of the failure merely to make the run proceed.

If creation succeeded but public verification failed, leave the tag fixed and
the release record available for diagnosis. Prefer fix-forward with a new
version and new tag. If a severe defect requires withdrawal, mark the affected
release clearly and remove its release record only through an explicit incident
decision; never move or reuse its tag. Source rollback does not rewrite a
published release.

## RC retirement after stable verification

RC retirement is a separate, destructive operation and is never part of this
workflow. Keep every RC intact until the stable release has passed anonymous
public verification for release class, Latest status, all six assets,
checksums, extraction, and applicable signatures.

BL-005 is the rollout and retirement issue. It remains open through stable
publication and RC retirement. Before publication, the unresolved-P0 check
applies to every v0.1.0 milestone P0 except BL-005 itself; this is only a narrow
self-reference exception, not a general waiver. Close BL-005 only after stable
verification, RC release deletion, RC remote-tag deletion, and a final
enumeration confirms the intended stable release, assets, and tags remain.

Only then, under explicit authorization, retire RCs in this order:

1. Delete the obsolete RC GitHub release records.
2. Confirm the stable release and assets remain publicly correct.
3. Delete the corresponding remote RC tags.

Do not delete local or remote RC tags first, do not delete the stable tag, and
do not close release issues merely because stable automation started.
