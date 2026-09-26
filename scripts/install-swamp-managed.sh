#!/bin/sh
set -eu

expected_version=20260926.025243.0
release_tag=v20260926.025243.0-sha.0f086bc8
expected_sha256=5ded771704f72639aee964941eca052556b9dbeca08760f0c4f592415655b419

version=
while IFS=': ' read -r key value; do
  if [ "$key" = swampVersion ]; then
    version=$value
    break
  fi
done < .swamp.yaml

if [ "$version" != "$expected_version" ]; then
  printf '%s\n' "Unsupported .swamp.yaml version: $version" >&2
  exit 1
fi
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  printf '%s\n' "Managed Swamp bootstrap supports linux-x86_64 only" >&2
  exit 1
fi

temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT HUP INT TERM
url="https://github.com/swamp-club/swamp/releases/download/$release_tag/swamp-linux-x86_64"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  "$url" --output "$temporary"
printf '%s  %s\n' "$expected_sha256" "$temporary" | sha256sum --check --status
mkdir -p "$HOME/.local/bin"
chmod 0755 "$temporary"
mv "$temporary" "$HOME/.local/bin/swamp"
trap - EXIT HUP INT TERM
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$HOME/.local/bin" >> "$GITHUB_PATH"
fi
"$HOME/.local/bin/swamp" --version
