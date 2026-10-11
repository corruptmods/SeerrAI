#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

git pull

COMMIT=$(git rev-parse --short HEAD)
docker build --build-arg COMMIT_TAG="$COMMIT" -t seerr-custom:latest .

echo
echo "Built $COMMIT as seerr-custom:latest. Restart the container to use it."
