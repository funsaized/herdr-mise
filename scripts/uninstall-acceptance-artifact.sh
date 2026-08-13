#!/bin/sh
# Removes one explicitly named acceptance version; never removes an install root.
set -eu
install_root=${1:?usage: uninstall-acceptance-artifact.sh INSTALL_ROOT VERSION}
version=${2:?usage: uninstall-acceptance-artifact.sh INSTALL_ROOT VERSION}
case "$version" in *[!0-9A-Za-z.-]*|'') echo "invalid version" >&2; exit 1 ;; esac
case "$version" in current|.|..) echo "reserved version name: $version" >&2; exit 1 ;; esac
base="$install_root/herdr-mise"
target="$base/$version"
[ ! -L "$target" ] || { echo "refusing symlink target: $target" >&2; exit 1; }
[ -f "$target/artifact-sha256" ] && [ -f "$target/public-source-url" ] || { echo "not a verified acceptance install: $target" >&2; exit 1; }
if [ -L "$base/current" ] && [ "$(readlink "$base/current")" = "$version" ]; then
  echo "refusing to uninstall selected current version; select another version first" >&2
  exit 1
fi
rm -rf "$target"
echo "uninstalled=$target"
