#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR/apps/website"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run wrangler."
  exit 1
fi

./deploy.sh

echo ""
echo "Add bondfires.org as a custom domain in the Cloudflare Pages project if it is not already attached."
