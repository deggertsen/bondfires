#!/bin/bash
set -euo pipefail

# release.sh — Deploy Convex backend, bump version, build iOS + Android, and auto-submit to app stores
#
# Usage:
#   ./scripts/release.sh [patch|minor|major]
#
# Defaults to "patch" if no argument given.
# Requires: eas-cli, jq, convex CLI (npx convex)

BUMP_TYPE="${1:-patch}"
APP_JSON="apps/mobile/app.json"

cd "$(git rev-parse --show-toplevel)"

# --- Validate clean working tree ---
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# --- Read current version ---
CURRENT_VERSION=$(jq -r '.expo.version' "$APP_JSON")
echo "📦 Current version: $CURRENT_VERSION"

# --- Bump version ---
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *)
    echo "❌ Invalid bump type: $BUMP_TYPE (use patch, minor, or major)"
    exit 1
    ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "🔼 Bumping to: $NEW_VERSION"

# --- Update app.json ---
jq --arg v "$NEW_VERSION" '.expo.version = $v' "$APP_JSON" > "$APP_JSON.tmp" && mv "$APP_JSON.tmp" "$APP_JSON"

# --- Commit the version bump ---
git add "$APP_JSON"
git commit -m "chore: bump version to $NEW_VERSION for release"
echo "✅ Committed version bump"

# --- Deploy Convex backend to production ---
echo "⚡ Deploying Convex backend to production..."
npx convex deploy
echo "✅ Convex backend deployed"

# --- Update minAppVersion in Convex publicConfig ---
echo "🔒 Setting minAppVersion to $NEW_VERSION..."
npx convex run publicConfig:setMinVersion "{\"version\":\"$NEW_VERSION\"}"
echo "✅ minAppVersion set to $NEW_VERSION"

# --- Build + auto-submit both platforms ---
echo "🚀 Starting EAS builds with auto-submit..."
cd apps/mobile
npx eas-cli build \
  --platform all \
  --profile production \
  --non-interactive \
  --auto-submit

echo ""
echo "🎉 Builds queued with auto-submit! Check progress at:"
echo "   https://expo.dev/accounts/deggertsen/projects/bondfires/builds"
