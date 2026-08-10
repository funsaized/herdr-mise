#!/bin/sh
set -eu

test -x target/release/herdr-mise
grep -q 'aarch64-apple-darwin' .github/workflows/release.yml
grep -q 'x86_64-apple-darwin' .github/workflows/release.yml
grep -q 'x86_64-unknown-linux-gnu' .github/workflows/release.yml
grep -q 'herdr-mise-v\*-${{ matrix.target }}.tar.gz' .github/workflows/release.yml
grep -q 'sha256' .github/workflows/release.yml
sh scripts/smoke-release.sh target/release/herdr-mise
sh scripts/measure-server.sh target/release/herdr-mise
