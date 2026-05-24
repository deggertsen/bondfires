#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${CLOUDFLARE_PAGES_PROJECT:-bondfires-website}"
BRANCH="${CLOUDFLARE_PAGES_BRANCH:-${CF_PAGES_BRANCH:-main}}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required."
  echo "Workers Builds auto-created tokens usually lack Cloudflare Pages permissions."
  echo "Create a custom token at https://dash.cloudflare.com/profile/api-tokens with:"
  echo "  Account > Cloudflare Pages > Edit"
  echo "  Account > Account Settings > Read"
  echo "Then add it as an encrypted build variable named CLOUDFLARE_API_TOKEN."
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "Warning: CLOUDFLARE_ACCOUNT_ID is not set. Wrangler will infer it from the token."
fi

echo "Deploying current directory to Cloudflare Pages project: $PROJECT_NAME"

npx --yes wrangler@4 pages deploy . \
  --project-name="$PROJECT_NAME" \
  --branch="$BRANCH" \
  --commit-dirty=true

echo ""
echo "Deployment complete."
