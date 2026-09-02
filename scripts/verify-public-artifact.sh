#!/bin/sh
# Anonymous public download, exact archive/checksum verification, and a
# versioned user-path install. Defaults to a new temporary install root.
set -eu

archive_url=${1:?usage: verify-public-artifact.sh ARCHIVE_URL CHECKSUM_SOURCE VERSION [INSTALL_ROOT]}
checksum_source=${2:?usage: verify-public-artifact.sh ARCHIVE_URL CHECKSUM_SOURCE VERSION [INSTALL_ROOT]}
version=${3:?usage: verify-public-artifact.sh ARCHIVE_URL CHECKSUM_SOURCE VERSION [INSTALL_ROOT]}
install_root=${4:-$(mktemp -d "${TMPDIR:-/tmp}/herdr-mise-install.XXXXXX")}

case "$version" in *[!0-9A-Za-z.-]*|'') echo "invalid version: $version" >&2; exit 1 ;; esac
if [ "${ACCEPTANCE_ALLOW_FILE_URLS:-0}" = 1 ]; then
  allowed='https://|file://'
else
  allowed='https://'
fi
case "$archive_url" in https://*) ;; file://*) [ "$allowed" = 'https://|file://' ] || { echo "public artifact URL must use HTTPS" >&2; exit 1; } ;; *) echo "public artifact URL must use HTTPS" >&2; exit 1 ;; esac
case "$checksum_source" in
  https://*) ;;
  file://*) [ "$allowed" = 'https://|file://' ] || { echo "public checksum URL must use HTTPS" >&2; exit 1; } ;;
  *) [ -f "$checksum_source" ] || { echo "checksum file not found: $checksum_source" >&2; exit 1; } ;;
esac

download=$(mktemp -d "${TMPDIR:-/tmp}/herdr-mise-download.XXXXXX")
stage=$(mktemp -d "${TMPDIR:-/tmp}/herdr-mise-stage.XXXXXX")
trap 'rm -rf "$download" "$stage"' EXIT INT TERM
archive_name=${archive_url%%\?*}
archive_name=${archive_name##*/}
[ -n "$archive_name" ] || { echo "artifact URL has no filename" >&2; exit 1; }
archive="$download/$archive_name"

curl -q --fail --silent --show-error --location --retry 3 --retry-all-errors --netrc-file /dev/null "$archive_url" -o "$archive"
case "$checksum_source" in
  https://*|file://*)
    checksum="$archive.sha256"
    curl -q --fail --silent --show-error --location --retry 3 --retry-all-errors --netrc-file /dev/null "$checksum_source" -o "$checksum"
    ;;
  *) checksum=$checksum_source ;;
esac

expected=$(awk 'NF == 2 { print $1; exit }' "$checksum")
recorded=$(awk 'NF == 2 { print $2; exit }' "$checksum")
[ "$recorded" = "$archive_name" ] || { echo "checksum names wrong file: $recorded" >&2; exit 1; }
case "$expected" in *[!0-9a-f]*|'') echo "malformed checksum" >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || { echo "malformed checksum" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$archive" | awk '{print $1}'); else actual=$(shasum -a 256 "$archive" | awk '{print $1}'); fi
[ "$actual" = "$expected" ] || { echo "checksum mismatch" >&2; exit 1; }

contents=$(tar -tzf "$archive")
expected_contents=$(printf '%s\n' herdr-mise LICENSE THIRD_PARTY_NOTICES.txt)
[ "$contents" = "$expected_contents" ] || { echo "unexpected archive contents" >&2; exit 1; }
tar -C "$stage" -xzf "$archive"
[ -x "$stage/herdr-mise" ] || { echo "artifact binary is not executable" >&2; exit 1; }
[ -f "$stage/LICENSE" ] && [ -f "$stage/THIRD_PARTY_NOTICES.txt" ] || { echo "artifact notices missing" >&2; exit 1; }

destination="$install_root/herdr-mise/$version"
[ ! -e "$destination" ] || { echo "version already installed: $destination" >&2; exit 1; }
mkdir -p "$destination/bin" "$destination/share"
cp "$stage/herdr-mise" "$destination/bin/herdr-mise"
cp "$stage/LICENSE" "$stage/THIRD_PARTY_NOTICES.txt" "$destination/share/"
printf '%s\n' "$actual" >"$destination/artifact-sha256"
printf '%s\n' "$archive_url" >"$destination/public-source-url"
chmod 755 "$destination/bin/herdr-mise"
chmod 644 "$destination/share/LICENSE" "$destination/share/THIRD_PARTY_NOTICES.txt"
chmod 644 "$destination/artifact-sha256" "$destination/public-source-url"

# Keep the previous version available for rollback while selecting the newly
# verified version. The install root is caller-selected.
ln -s "$version" "$install_root/herdr-mise/current.next"
rm -f "$install_root/herdr-mise/current"
mv "$install_root/herdr-mise/current.next" "$install_root/herdr-mise/current"

if [ "${ACCEPTANCE_SKIP_SMOKE:-0}" != 1 ]; then
  sh scripts/verify-release-artifact.sh "$archive"
fi
printf 'artifact_sha256=%s\ninstall_path=%s\n' "$actual" "$destination/bin/herdr-mise"
