#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${CLOUDFLARE_PAGES_PROJECT:-bondfires-website}"
BRANCH="${CLOUDFLARE_PAGES_BRANCH:-${CF_PAGES_BRANCH:-main}}"

echo "Deploying current directory to Cloudflare Pages project: $PROJECT_NAME"

npx --yes wrangler@4 pages deploy . \
  --project-name="$PROJECT_NAME" \
  --branch="$BRANCH" \
  --commit-dirty=true

echo ""
echo "Deployment complete."
