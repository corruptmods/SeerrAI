#!/usr/bin/env bash
#
# Applies fork patches, but only onto the exact code they were made for.
#
#   ./apply-patches.sh /path/to/0086-*.patch [/path/to/0087-*.patch ...]
#
# Each patch carries two stamps after its "---" line (git am ignores them):
#   base-tree:   the tree this patch expects to start from
#   result-tree: the tree it must leave behind
# The first patch's base must match this checkout exactly, and after the last
# one the tree must match its result. Anything else stops before a single file
# is touched, or rolls back, so a skipped or half-applied patch is caught at
# the next deploy instead of weeks later.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 PATCH [PATCH ...]  (in order)" >&2
  exit 2
fi

stamp() { sed -n "s/^$1: \([0-9a-f]\{40\}\)\$/\1/p" "$2" | head -n 1; }

for patch in "$@"; do
  if [ ! -f "$patch" ]; then
    echo "No such patch: $patch" >&2
    exit 2
  fi
  if [ -z "$(stamp base-tree "$patch")" ] || [ -z "$(stamp result-tree "$patch")" ]; then
    echo "Not applying: $patch has no base-tree/result-tree stamp." >&2
    exit 1
  fi
done

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Not applying: there are uncommitted changes." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi
if [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
  echo "Not applying: an earlier 'git am' is unfinished (git am --abort)." >&2
  exit 1
fi

here=$(git rev-parse 'HEAD^{tree}')
expected=$(stamp base-tree "$1")
if [ "$here" != "$expected" ]; then
  echo "Not applying: this checkout is not what $(basename "$1") was made for." >&2
  echo "  expected tree $expected" >&2
  echo "  found tree    $here" >&2
  echo "A patch was probably skipped or changed. Nothing was touched." >&2
  exit 1
fi

# Commits keep the author as committer, and the author's time, so they come
# out identical to the ones the patches were made from — whatever name this
# machine's git is set up with.
author=$(sed -n 's/^From: \(.*\) <\(.*\)>$/\1\t\2/p' "$1" | head -n 1)
if [ -z "$author" ]; then
  echo "Not applying: $(basename "$1") has no author line." >&2
  exit 1
fi
export GIT_COMMITTER_NAME="${author%%$'\t'*}"
export GIT_COMMITTER_EMAIL="${author#*$'\t'}"
start=$(git rev-parse HEAD)
if ! git am --committer-date-is-author-date --quiet "$@"; then
  git am --abort 2>/dev/null || true
  git reset --quiet --hard "$start"
  echo "A patch did not apply; everything was put back as it was." >&2
  exit 1
fi

final=$(git rev-parse 'HEAD^{tree}')
wanted=$(stamp result-tree "${!#}")
if [ "$final" != "$wanted" ]; then
  git reset --quiet --hard "$start"
  echo "The patches applied but did not produce the expected code; undone." >&2
  echo "  expected tree $wanted" >&2
  echo "  got tree      $final" >&2
  exit 1
fi

echo "Applied $# patch(es); code matches exactly (tree $final)."
