#!/bin/sh
set -eu

expected_version=20260827.184833.0
release_tag=v20260827.184833.0-sha.ce230776
expected_sha256=61175af302a50f5539e148608b5fffcdf901effea2ac6f268ff209ab8e33eed5

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
