#!/bin/sh
# Retire the release candidates of one verified stable release, in the order
# docs/releasing.md requires. Dry run by default; pass --apply to delete.
#
#   sh scripts/retire-rcs.sh v0.3.0          # show what would be retired
#   sh scripts/retire-rcs.sh v0.3.0 --apply  # delete RC releases, then RC tags
set -eu

repo=funsaized/herdr-mise
stable=${1:?usage: retire-rcs.sh <stable tag> [--apply]}
apply=${2:-}
node scripts/release-policy.mjs classify-tag "$stable" | grep -q '"releaseClass":"stable"' ||
  { echo "not a stable tag: $stable" >&2; exit 1; }

require_stable() {
  gh release view "$stable" --repo "$repo" \
    --json isDraft,isPrerelease,assets \
    --jq 'select(.isDraft == false and .isPrerelease == false and (.assets | length) == 6) | "ok"' |
    grep -qx ok || { echo "$stable is not a published stable release with six assets" >&2; exit 1; }
}

require_stable
prefix="$stable-rc."
releases=$(gh release list --repo "$repo" --limit 100 --json tagName --jq ".[].tagName | select(startswith(\"$prefix\"))")
tags=$(git ls-remote --tags "https://github.com/$repo.git" "$prefix*" | awk '{print $2}' | grep -v '\^{}$' | sed 's#^refs/tags/##' || true)
echo "Stable $stable verified."
echo "RC releases: ${releases:-none}"
echo "RC tags: ${tags:-none}"
[ "$apply" = "--apply" ] || { echo "Dry run; pass --apply to retire."; exit 0; }

for tag in $releases; do
  gh release delete "$tag" --repo "$repo" --yes
done
require_stable
for tag in $tags; do
  git push "https://github.com/$repo.git" ":refs/tags/$tag"
done
echo "Retired: releases [${releases}] tags [${tags}]"
