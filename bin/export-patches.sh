#!/usr/bin/env bash
#
# Writes the commits after BASE as numbered patches for apply-patches.sh,
# each stamped with the tree it starts from and the tree it produces.
#
#   bin/export-patches.sh BASE START_NUMBER OUT_DIR
#   bin/export-patches.sh HEAD~2 86 /tmp/patches
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -ne 3 ]; then
  echo "usage: $0 BASE START_NUMBER OUT_DIR" >&2
  exit 2
fi
base=$1
number=$2
out=$3
mkdir -p "$out"

for commit in $(git rev-list --reverse "$base..HEAD"); do
  file=$(git format-patch --start-number "$number" -o "$out" -1 "$commit")
  before=$(git rev-parse "$commit^^{tree}")
  after=$(git rev-parse "$commit^{tree}")
  # Text between the "---" line and the diff is ignored by git am.
  awk -v b="$before" -v a="$after" '
    !done && /^---$/ { print; print "base-tree: " b; print "result-tree: " a; done = 1; next }
    { print }
  ' "$file" >"$file.tmp"
  mv "$file.tmp" "$file"
  echo "$file"
  number=$((number + 1))
done
