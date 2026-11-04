# Release operations

The [Release workflow](../.github/workflows/release.yml) builds, signs,
publishes, and verifies releases. Pull requests and manual runs validate only;
publication requires an explicitly authorized version tag.

## Prepare

1. Update `server/Cargo.toml`, `Cargo.lock`, `herdr-plugin.toml`, and
   `HERDR_MISE_VERSION` in `install.sh`, plus current installation and support
   guidance in `README.md`, `docs/operations.md`, and `SECURITY.md`.
2. For a stable release, add `docs/releases/<TAG>.md` with the exact level-two
   headings `Purpose`, `Install`, `Herdr compatibility`, and `Limitations`.
   Include checksum-first installation instructions and supported platforms.
   The workflow appends `Checksums` from the built archives; leave that heading
   out of the template. Prereleases use generated notes.
3. Complete [product verification](local-verification.md) on the intended
   commit and confirm the [Apple credentials](#apple-trust-setup) are configured.

`server/Cargo.toml` is the version authority. Tags must match it exactly, use a
lowercase `v` prefix and canonical SemVer, and contain no build metadata.
Prerelease suffixes produce GitHub prereleases; unsuffixed versions are stable.
Published tags are immutable.

## Publish

From the reviewed commit and a clean checkout:

```sh
VERSION=$(sed -n '/^\[package\]/,/^\[/s/^version = "\([^"]*\)"/\1/p' server/Cargo.toml)
TAG=v$VERSION
test -z "$(git status --porcelain)"
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
```

Wait for all **Release** jobs, including public verification. The workflow:

- Builds macOS arm64 (`macos-15`), macOS x86_64 (`macos-15-intel`), and Linux
  x86_64 (`ubuntu-24.04`, glibc 2.39 baseline).
- Signs and notarizes macOS binaries, then packages three archives and three
  SHA-256 sidecars.
- Assembles a draft and publishes only the complete six-asset set. Retries
  compare existing bytes and upload only missing assets.
- Downloads every archive anonymously and verifies checksums, contents,
  startup, and macOS signatures. Stable releases must become Latest;
  prereleases must not.
- Checks stable public metadata against version pins, installation guidance,
  supported platforms, security policy, and the release-note template.

After public verification, check plugin and standalone installation against
that release and [update Homebrew](#homebrew-tap-update).

## Homebrew tap update

Generate the formula from published sidecars:

```sh
gh repo clone funsaized/homebrew-tap /tmp/homebrew-tap
node scripts/homebrew-formula.mjs "$TAG" \
  < /tmp/homebrew-tap/Formula/herdr-mise.rb > /tmp/herdr-mise.rb
mv /tmp/herdr-mise.rb /tmp/homebrew-tap/Formula/herdr-mise.rb
```

Open a pull request in the tap. Merge after its audit, install, test, and
uninstall checks pass on the supported platforms, then verify
`brew update && brew upgrade herdr-mise` from the preceding version.
The generator rejects prereleases and malformed or mismatched sidecars.

## Apple trust setup

Configure once and update when credentials change. Use a **Developer ID
Application** certificate, exported with its private key as a
password-protected `.p12`. Create an App Store Connect **Team Key** with the
App Manager role; Individual Keys cannot use `notarytool`. Retain its `.p8`,
Key ID, and Issuer ID.

Encode file credentials locally without printing their values:

```sh
openssl base64 -A -in DeveloperID.p12 -out certificate.p12.base64
openssl base64 -A -in AuthKey_KEYID.p8 -out AuthKey.p8.base64
```

Set repository secrets from a trusted checkout:

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

Delete local encoded copies after upload; never commit credentials. The
workflow uses an ephemeral keychain and removes signing material on completion.
This standalone CLI has no stapling target: verification uses an accepted
notarization submission and a Developer ID signature with hardened runtime
and a secure timestamp.

## Failure recovery

Inspect the failed job and retained artifacts before retrying. Transient or
credential-only failures can use the same inputs. Source or notes-template
changes after tagging require a new version and tag.

A signed rebuild can produce different bytes. Retry publication with the
original retained `release-*` artifacts; existing public assets are never
overwritten. Metadata, notes, or asset mismatches require investigation.
Keep failed release records available for diagnosis and fix forward. Withdrawal
of a defective release is a separate explicit decision; never move or reuse its
tag.

For an Apple notarization rejection, retrieve the log:

```sh
xcrun notarytool log SUBMISSION_ID \
  --key /path/to/AuthKey_KEYID.p8 \
  --key-id KEYID \
  --issuer ISSUER_ID
```

Check the certificate type, Team Key permissions, hardened runtime, and secure
timestamp. To inspect an extracted public binary, use
`codesign --verify --deep --strict --verbose=2 ./herdr-mise` and
`codesign -dv --verbose=4 ./herdr-mise`.

### Recheck public guidance

After correcting current stable documentation, compare it with fresh public
metadata:

```sh
VERSION=$(sed -n '/^\[package\]/,/^\[/s/^version = "\([^"]*\)"/\1/p' server/Cargo.toml)
TAG=v$VERSION
curl -q --fail --silent --show-error \
  "https://api.github.com/repos/funsaized/herdr-mise/releases/tags/$TAG" -o release.json
curl -q --fail --silent --show-error \
  https://api.github.com/repos/funsaized/herdr-mise/releases/latest -o latest.json
node scripts/check-release-consistency.mjs release.json latest.json
```

This checks guidance against the current stable release; archive and signature
verification remain part of the Release workflow. Ordinary PR tests use captured
fixtures and do not require publication.
