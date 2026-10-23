#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

git pull

# Nothing is built while a security advisory stands (security-check.sh).
if ! ./security-check.sh; then
  echo
  echo "Not built: fix what the security check found above, then run this again."
  exit 1
fi

COMMIT=$(git rev-parse --short HEAD)
docker build \
  --build-arg COMMIT_TAG="$COMMIT" \
  --build-arg ALPINE_FIXES_DAY="$(date +%F)" \
  -t seerr-custom:latest .

echo
echo "Built $COMMIT as seerr-custom:latest. Restart the container to use it."
