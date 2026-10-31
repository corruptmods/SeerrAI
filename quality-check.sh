#!/usr/bin/env bash
# Seerr AI's own quality presets against TRaSH Guides, before every build
# (build.sh runs this): what changed in TRaSH Guides since the presets were
# last reviewed, and what they could take from it. A report only; it never
# stops a build. See bin/quality-review.mjs.
# It runs in the image's own Node.js, so the host needs only Docker.
#   QUALITY_CHECK_HERE=1 ./quality-check.sh            with this machine's Node.js
#   QUALITY_CHECK_HERE=1 ./quality-check.sh --accept   record it as reviewed
set -uo pipefail
cd "$(dirname "$0")"

CACHE=.cache/quality-review
mkdir -p "$CACHE"

if [ "${QUALITY_CHECK_HERE:-}" = 1 ]; then
  node --experimental-strip-types --no-warnings \
    bin/quality-review.mjs --cache "$CACHE" "$@"
else
  BASE=$(awk '/^FROM node:/ { print $2; exit }' Dockerfile)
  docker run --rm \
    -v "$PWD:/check:ro" \
    -v "$PWD/$CACHE:/cache" \
    -w /check \
    --entrypoint node \
    "$BASE" --experimental-strip-types --no-warnings \
    bin/quality-review.mjs --cache /cache
fi || echo "The quality check didn't finish."
exit 0
