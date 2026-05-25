#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"
npx wrangler d1 migrations apply DB \
  --local \
  --persist-to .wrangler/state \
  --config packages/control-plane/wrangler.dev.jsonc
