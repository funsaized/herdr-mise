#!/bin/sh
set -eu

test -x target/release/herdr-mise
version=$(sed -n '/^\[package\]/,/^\[/s/^version = "\([^"]*\)"/\1/p' server/Cargo.toml)
test "$(sed -n 's/^version = "\([^"]*\)"/\1/p' herdr-plugin.toml)" = "$version"
grep -qx "HERDR_MISE_VERSION=$version" install.sh
grep -q 'aarch64-apple-darwin' .github/workflows/release.yml
grep -q 'x86_64-apple-darwin' .github/workflows/release.yml
grep -q 'x86_64-unknown-linux-gnu' .github/workflows/release.yml
grep -q 'herdr-mise-v\*-${{ matrix.target }}.tar.gz' .github/workflows/release.yml
grep -q 'sha256' .github/workflows/release.yml
sh scripts/smoke-release.sh target/release/herdr-mise
sh scripts/measure-server.sh target/release/herdr-mise
