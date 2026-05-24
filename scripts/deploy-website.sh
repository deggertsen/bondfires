#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_NAME="${CLOUDFLARE_PAGES_PROJECT:-bondfires-website}"
BRANCH="${CLOUDFLARE_PAGES_BRANCH:-main}"

cd "$ROOT_DIR"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run wrangler."
  exit 1
fi

echo "Deploying apps/website to Cloudflare Pages project: $PROJECT_NAME"

npx --yes wrangler@4 pages deploy apps/website \
  --project-name="$PROJECT_NAME" \
  --branch="$BRANCH" \
  --commit-dirty=true

echo ""
echo "Deployment complete."
echo "Add bondfires.org as a custom domain in the Cloudflare Pages project if it is not already attached."
