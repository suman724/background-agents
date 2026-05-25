#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PACKAGE_DIR="$REPO_ROOT/packages/sandbox-runtime"
IMAGE_TAG="${SANDBOX_IMAGE_TAG:-openinspect/sandbox-runtime:dev}"

echo "[build-sandbox-image] building $IMAGE_TAG from $PACKAGE_DIR"
docker build \
  --tag "$IMAGE_TAG" \
  --file "$PACKAGE_DIR/Dockerfile" \
  "$PACKAGE_DIR"

echo "[build-sandbox-image] done. Image: $IMAGE_TAG"
docker images "$IMAGE_TAG" --format 'size: {{.Size}}'
