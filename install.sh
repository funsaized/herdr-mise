#!/bin/sh
set -eu

HERDR_MISE_VERSION=0.2.0
release_base=${HERDR_MISE_RELEASE_BASE_URL:-https://github.com/funsaized/herdr-mise/releases/download/v$HERDR_MISE_VERSION}
mode=${1:-standalone}

case "$mode" in
  standalone) ;;
  --plugin) mode=plugin ;;
  *) echo "usage: install.sh [--plugin]" >&2; exit 2 ;;
esac

system=$(uname -s)
machine=$(uname -m)
case "$system-$machine" in
  Darwin-arm64) target=aarch64-apple-darwin ;;
  Darwin-x86_64) target=x86_64-apple-darwin ;;
  Linux-x86_64)
    if command -v ldd >/dev/null 2>&1; then
      libc=$(ldd --version 2>&1 || true)
      case "$libc" in *musl*) echo "unsupported platform: Linux musl requires a glibc build" >&2; exit 1 ;; esac
    fi
    target=x86_64-unknown-linux-gnu
    ;;
  *) echo "unsupported platform: $system $machine (supported: macOS arm64/x86_64 and Linux x86_64 glibc)" >&2; exit 1 ;;
esac

archive_name="herdr-mise-v$HERDR_MISE_VERSION-$target.tar.gz"
archive_url="$release_base/$archive_name"
checksum_url="$archive_url.sha256"
case "$archive_url" in
  https://*) ;;
  file://*) [ "${HERDR_MISE_TEST_ALLOW_FILE_URLS:-0}" = 1 ] || { echo "artifact URL must use HTTPS" >&2; exit 1; } ;;
  *) echo "artifact URL must use HTTPS" >&2; exit 1 ;;
esac
case "$checksum_url" in
  https://*) ;;
  file://*) [ "${HERDR_MISE_TEST_ALLOW_FILE_URLS:-0}" = 1 ] || { echo "checksum URL must use HTTPS" >&2; exit 1; } ;;
  *) echo "checksum URL must use HTTPS" >&2; exit 1 ;;
esac

download=$(mktemp -d "${TMPDIR:-/tmp}/herdr-mise-download.XXXXXX")
stage=$(mktemp -d "${TMPDIR:-/tmp}/herdr-mise-stage.XXXXXX")
install_stage=
link_stage=
trap 'rm -rf "$download" "$stage"; [ -z "$install_stage" ] || rm -rf "$install_stage"; [ -z "$link_stage" ] || rm -f "$link_stage"' EXIT HUP INT TERM

atomic_link() {
  link_target=$1
  link_path=$2
  if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
    echo "refusing to overwrite non-symlink: $link_path" >&2
    exit 1
  fi
  link_stage="$link_path.tmp.$$"
  ln -s "$link_target" "$link_stage"
  mv -Tf "$link_stage" "$link_path" 2>/dev/null || mv -fh "$link_stage" "$link_path"
  link_stage=
}

archive="$download/$archive_name"
checksum="$archive.sha256"

curl -q --fail --silent --show-error --location --retry 3 --retry-all-errors --netrc-file /dev/null "$archive_url" -o "$archive"
curl -q --fail --silent --show-error --location --retry 3 --retry-all-errors --netrc-file /dev/null "$checksum_url" -o "$checksum"

expected=$(awk 'NF == 2 { print $1; exit }' "$checksum")
recorded=$(awk 'NF == 2 { print $2; exit }' "$checksum")
[ "$recorded" = "$archive_name" ] || { echo "checksum names wrong file: $recorded" >&2; exit 1; }
case "$expected" in *[!0-9a-f]*|'') echo "malformed checksum" >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || { echo "malformed checksum" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$archive" | awk '{print $1}')
else
  echo "sha256sum or shasum is required" >&2
  exit 1
fi
[ "$actual" = "$expected" ] || { echo "checksum mismatch" >&2; exit 1; }

contents=$(tar -tzf "$archive")
expected_contents=$(printf '%s\n' herdr-mise LICENSE THIRD_PARTY_NOTICES.txt)
[ "$contents" = "$expected_contents" ] || { echo "unexpected archive contents" >&2; exit 1; }
tar -C "$stage" -xzf "$archive"
[ -x "$stage/herdr-mise" ] || { echo "artifact binary is not executable" >&2; exit 1; }
[ -f "$stage/LICENSE" ] && [ -f "$stage/THIRD_PARTY_NOTICES.txt" ] || { echo "artifact notices missing" >&2; exit 1; }

if [ "$mode" = plugin ]; then
  base=${HERDR_MISE_PLUGIN_ROOT:-$PWD/target/herdr-plugin}/herdr-mise
else
  data_home=${HERDR_MISE_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}}
  bin_dir=${HERDR_MISE_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}
  base="$data_home/herdr-mise"
  launcher="$bin_dir/herdr-mise"
  if [ -e "$launcher" ] && [ ! -L "$launcher" ]; then
    echo "refusing to overwrite non-symlink: $launcher" >&2
    exit 1
  fi
fi
destination="$base/$HERDR_MISE_VERSION"
mkdir -p "$base"
if [ -e "$destination" ]; then
  [ -f "$destination/artifact-sha256" ] && [ "$(sed -n '1p' "$destination/artifact-sha256")" = "$actual" ] || {
    echo "installed version does not match release artifact: $destination" >&2
    exit 1
  }
else
  install_stage="$base/.$HERDR_MISE_VERSION.tmp.$$"
  rm -rf "$install_stage"
  mkdir -p "$install_stage/bin" "$install_stage/share"
  cp "$stage/herdr-mise" "$install_stage/bin/herdr-mise"
  cp "$stage/LICENSE" "$stage/THIRD_PARTY_NOTICES.txt" "$install_stage/share/"
  printf '%s\n' "$actual" >"$install_stage/artifact-sha256"
  printf '%s\n' "$archive_url" >"$install_stage/public-source-url"
  chmod 755 "$install_stage/bin/herdr-mise"
  chmod 644 "$install_stage/share/LICENSE" "$install_stage/share/THIRD_PARTY_NOTICES.txt" "$install_stage/artifact-sha256" "$install_stage/public-source-url"
  mv "$install_stage" "$destination"
  install_stage=
fi

atomic_link "$HERDR_MISE_VERSION" "$base/current"

if [ "$mode" = standalone ]; then
  mkdir -p "$bin_dir"
  atomic_link "$base/current/bin/herdr-mise" "$launcher"
  case ":${PATH:-}:" in
    *":$bin_dir:"*) ;;
    *) echo "warning: $bin_dir is not in PATH" >&2 ;;
  esac
  printf 'installed herdr-mise %s at %s\n' "$HERDR_MISE_VERSION" "$launcher"
else
  printf 'installed herdr-mise %s at %s\n' "$HERDR_MISE_VERSION" "$destination/bin/herdr-mise"
fi
