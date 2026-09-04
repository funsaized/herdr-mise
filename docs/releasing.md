# Release operations

This is the operator runbook for release candidates and stable releases. It
does not authorize a tag or publication; the GitHub releases page is
authoritative for what has been published.

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

The first stable release, `v0.1.0`, is complete. Its RC1 acceptance contract is
retained as a historical, test-consumed record in `stable-acceptance.md`; it
must not be reused for another stable release. A future stable release needs a
new accepted RC, evidence contract, and validator inputs before its tag is
created.

Both release classes retain the same three platform archives and three SHA-256
sidecars, signing/notarization checks, exact-six-asset checks, rerun validation,
and anonymous public download verification. RCs are marked prerelease and are
verified not to be Latest. Stable releases are non-prereleases and must become
the public Latest release.

## Stable acceptance gate

The checked-in acceptance schema, template, and evidence describe v0.1.0 only.
Before another stable tag is created, replace those inputs with a contract bound
to the new accepted RC and promotion commit. Reusing the v0.1.0 RC1 evidence is
not valid acceptance for a later release.

Stable publication fails closed before release creation or upload. The
`stable_acceptance` workflow job runs only for a stable tag and is a dependency
of `publish`. Configure a protected GitHub environment named `stable-release`
with the base64-encoded, sanitized JSON record in the
`STABLE_ACCEPTANCE_EVIDENCE_BASE64` environment secret. Missing, empty,
malformed, incomplete, failing, or context-mismatched evidence blocks the job.
The validator must also emit its exact success marker; exit code zero alone is
not accepted. RC release workflows do not read this secret.

The checked-in acceptance validator owns the historical v0.1.0 gate list and
JSON Schema. Its evidence has two deliberately separate identities:

- `accepted_rc` identifies public prerelease `v0.1.0-rc.1`, its immutable tag
  commit, and the public archive URLs and SHA-256 values actually exercised.
  Every required acceptance row repeats that RC identity and references one or
  more of those exact artifacts. Public-artifact, manual, and multi-day soak
  results therefore describe the public RC they really tested.
- `promotion` identifies the v0.1.0 stable tag, Cargo version, and exact
  accepted `main` commit. The stable workflow passed its tag/version/commit to
  the validator and required an exact match before publication.

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

### Recorded v0.1.0 RC-to-stable flow

1. Public `v0.1.0-rc.1` archives, sidecars, URLs, targets, checksums, and the
   immutable RC tag commit were recorded and frozen.
2. Every BL-006 automated, manual, and elapsed multi-day soak gate ran against
   those installed public RC artifacts.
3. One exact `main` commit containing the stable Cargo version and release-notes
   template was selected and recorded in `promotion`.
4. The complete evidence record was validated, sanitized, and configured in the
   protected environment before tagging.
5. The stable tag was created at the accepted commit, and the workflow validated
   promotion identity and RC acceptance before publication.

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

## Signing and publishing

Publication is tag-triggered. Pull requests and manual workflow runs validate
without publication credentials; only a matching `v*` tag can sign, notarize,
and publish assets.

### Preconditions

Before tagging:

1. Confirm the working tree is clean and the tag target is the intended commit.
2. Confirm `server/Cargo.toml`, `herdr-plugin.toml`, and
   `HERDR_MISE_VERSION` in `install.sh` contain the intended version. For a
   stable release, also confirm `docs/releases/v<VERSION>.md` contains complete
   release notes. Do not leave the manifest or installer pointing at an
   unpublished version after the release workflow completes.
3. For a stable tag, install the new accepted-RC contract and complete its
   protected-environment evidence before creating the tag.
4. Run the relevant local gates from [CONTRIBUTING.md](../CONTRIBUTING.md).
5. Confirm the Apple signing and notarization secrets are configured for tagged
   macOS jobs.
6. Confirm all three archive/sidecar pairs will use the names resolved by both
   plugin and standalone installer modes.

### Apple trust setup

Use a **Developer ID Application** certificate, not a Mac Distribution
certificate. Export the identity and private key as a password-protected `.p12`.
Create an App Store Connect **Team Key** with the App Manager role; Individual
Keys cannot use `notarytool`. Download its `.p8` once and retain its Key ID and
Issuer ID.

Encode file credentials locally without printing their values:

```sh
openssl base64 -A -in DeveloperID.p12 -out certificate.p12.base64
openssl base64 -A -in AuthKey_KEYID.p8 -out AuthKey.p8.base64
```

Set these repository secrets from a trusted checkout:

```sh
gh secret set APPLE_CERTIFICATE_P12_BASE64 < certificate.p12.base64
gh secret set APPLE_CERTIFICATE_PASSWORD
gh secret set APPLE_SIGNING_IDENTITY
gh secret set APPLE_API_KEY_ID
gh secret set APPLE_API_ISSUER_ID
gh secret set APPLE_API_PRIVATE_KEY_BASE64 < AuthKey.p8.base64
```

| Secret                         | Contents                                           |
| ------------------------------ | -------------------------------------------------- |
| `APPLE_CERTIFICATE_P12_BASE64` | base64 of the Developer ID Application `.p12`      |
| `APPLE_CERTIFICATE_PASSWORD`   | password protecting that `.p12`                    |
| `APPLE_SIGNING_IDENTITY`       | full `Developer ID Application: …` identity string |
| `APPLE_API_KEY_ID`             | App Store Connect API key ID                       |
| `APPLE_API_ISSUER_ID`          | App Store Connect issuer ID                        |
| `APPLE_API_PRIVATE_KEY_BASE64` | base64 of the API key `.p8`                        |

Delete the local encoded files after upload. Never commit certificates, keys,
or encoded copies.

### Tag and publish

Derive the tag from the authoritative Cargo version, then create it only after
reviewing the exact commit:

```sh
VERSION=$(sed -n '/^\[package\]/,/^\[/s/^version = "\([^"]*\)"/\1/p' server/Cargo.toml)
TAG=v$VERSION
test -z "$(git status --porcelain)"
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
```

Wait for the **Release** workflow's build, publish, and public-verification jobs.
Confirm the release class and Latest status, then confirm exactly six assets:
three platform archives and their three `.sha256` sidecars. Finally, download an
asset anonymously and rerun its checksum and archive verifier.

### Tagged workflow contract

- `macos-15` builds `aarch64-apple-darwin`, `macos-15-intel` builds
  `x86_64-apple-darwin`, and `ubuntu-24.04` builds
  `x86_64-unknown-linux-gnu`.
- macOS jobs import the P12 into an ephemeral keychain, sign with hardened
  runtime and a secure timestamp, submit through `notarytool --wait`, verify the
  Developer ID signature, and delete credentials in `always()` cleanup.
- Packaging emits one archive and SHA-256 sidecar per target and runs
  `scripts/verify-release-artifact.sh` before upload.
- Publication rejects unexpected assets, uploads the exact expected set, and
  verifies the public release through anonymous downloads.
- After publication, test `install.sh` against the public release in plugin and
  standalone modes; both must resolve the same three archives and sidecars.

### Homebrew tap update

After the release passes public verification:

1. Copy the three SHA-256 values from the published sidecars, never local
   rebuilds.
2. Open a `funsaized/homebrew-tap` pull request updating the formula version,
   three URLs, and three hashes.
3. Require tap CI to audit, install, test, and uninstall the formula on macOS
   arm64, macOS x86_64 while runners exist, and Linux x86_64.
4. Merge the tap update and record its pull request or commit in the release
   checklist.
5. Verify `brew update && brew upgrade herdr-mise` from the preceding version.

Keep tap updates manual until at least two releases show cross-repository
automation is worth its token and maintenance cost.

### Standalone CLI notarization

The macOS artifact is a standalone Mach-O command-line executable, not an app
bundle. There is no stapling target. Applicable evidence is an accepted
`notarytool` submission plus a Developer ID signature retaining hardened runtime
and a secure timestamp. Do not use app-bundle assessment as the acceptance gate
for the extracted CLI.

### Intel runner horizon

The release workflow currently pins `macos-15-intel`. Review GitHub's current
runner inventory before each release and move the pin deliberately when that
label approaches retirement. Do not silently drop the Intel archive.

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

For an Apple notarization rejection, retrieve the diagnostic log with temporary
local key material:

```sh
xcrun notarytool log SUBMISSION_ID \
  --key /path/to/AuthKey_KEYID.p8 \
  --key-id KEYID \
  --issuer ISSUER_ID
```

Wrong certificate type, missing hardened runtime or timestamp, and insufficient
Team Key permissions are common causes. Fix credentials or source as
appropriate; credential-only transient failures may be rerun, while source or
acceptance changes require a new version and tag.

If public macOS signature verification fails, inspect the extracted public
artifact with `codesign --verify --deep --strict --verbose=2 ./herdr-mise` and
`codesign -dv --verbose=4 ./herdr-mise`. Require a Developer ID Application
authority, TeamIdentifier, runtime flag, and secure timestamp.

## RC retirement after stable verification

RC retirement is a separate, destructive operation and is never part of this
workflow. Keep every RC intact until the stable release has passed anonymous
public verification for release class, Latest status, all six assets,
checksums, extraction, and applicable signatures.

For v0.1.0, BL-005 remained open through stable publication and RC retirement.
The unresolved-P0 check applied to every v0.1.0 milestone P0 except BL-005
itself; this was a narrow self-reference exception, not a general waiver.
BL-005 closed only after stable verification, RC release deletion, RC
remote-tag deletion, and final enumeration of the remaining release, assets,
and tags.

Future RC retirement follows the same rule: only after stable public
verification and explicit authorization, retire RCs in this order:

1. Delete the obsolete RC GitHub release records.
2. Confirm the stable release and assets remain publicly correct.
3. Delete the corresponding remote RC tags.

Do not delete local or remote RC tags first, do not delete the stable tag, and
do not close release issues merely because stable automation started.
