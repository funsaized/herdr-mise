#!/bin/sh
set -eu

target=${1:-}
binary=${2:-}

if [ -z "$target" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=aarch64-apple-darwin ;;
    Darwin-x86_64) target=x86_64-apple-darwin ;;
    Linux-x86_64) target=x86_64-unknown-linux-gnu ;;
    *) echo "unsupported local release platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
fi

version=$(sed -n '/^\[package\]/,/^\[/s/^version = "\([^"]*\)"/\1/p' server/Cargo.toml)
[ -n "$version" ] || { echo "cannot read release version from server/Cargo.toml" >&2; exit 1; }
name="herdr-mise-v${version}-${target}"

if [ -z "$binary" ]; then
  npm run build
  cargo build --release --locked --bin herdr-mise --target "$target"
  binary="target/$target/release/herdr-mise"
fi
[ -x "$binary" ] || { echo "release binary is not executable: $binary" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT INT TERM
mkdir -p dist
cp "$binary" "$stage/herdr-mise"
cp LICENSE "$stage/LICENSE"
node scripts/generate-third-party-notices.mjs "$stage/THIRD_PARTY_NOTICES.txt"
chmod 755 "$stage/herdr-mise"
chmod 644 "$stage/LICENSE" "$stage/THIRD_PARTY_NOTICES.txt"
touch -t 197001010000 "$stage/herdr-mise" "$stage/LICENSE" "$stage/THIRD_PARTY_NOTICES.txt"
# Normalize archive metadata and suppress gzip timestamps/AppleDouble entries.
# GNU tar and the macOS bsdtar expose different owner-normalization flags.
tarball="$stage/$name.tar"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar --format=ustar --owner=0 --group=0 --numeric-owner \
    -C "$stage" -cf "$tarball" herdr-mise LICENSE THIRD_PARTY_NOTICES.txt
else
  COPYFILE_DISABLE=1 tar --format=ustar --uid 0 --gid 0 --uname root --gname root \
    -C "$stage" -cf "$tarball" herdr-mise LICENSE THIRD_PARTY_NOTICES.txt
fi
gzip -n <"$tarball" >"dist/$name.tar.gz"
if command -v shasum >/dev/null 2>&1; then
  digest=$(shasum -a 256 "dist/$name.tar.gz" | awk '{print $1}')
else
  digest=$(sha256sum "dist/$name.tar.gz" | awk '{print $1}')
fi
printf '%s  %s\n' "$digest" "$name.tar.gz" >"dist/$name.tar.gz.sha256"
echo "dist/$name.tar.gz"
echo "dist/$name.tar.gz.sha256"
