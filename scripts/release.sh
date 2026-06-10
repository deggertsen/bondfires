#!/bin/bash
set -euo pipefail

# release.sh — Deploy Convex backend, bump version, build iOS + Android LOCALLY,
# and submit to app stores.
#
# Builds run on this machine via `eas build --local` (no EAS build queue, no
# build-credit quota). Signing credentials are still pulled from EAS servers.
# `eas submit` uploads the local artifacts (unmetered).
#
# Usage:
#   ./scripts/release.sh [patch|minor|major] [--ios-only|--android-only]
#
# Defaults to "patch" if no argument given.
# Requires: eas-cli, jq, convex CLI (npx convex), Xcode + CocoaPods + fastlane
# (iOS), Android SDK + JDK (Android).

BUMP_TYPE="patch"
PLATFORMS=(ios android)
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP_TYPE="$arg" ;;
    --ios-only) PLATFORMS=(ios) ;;
    --android-only) PLATFORMS=(android) ;;
    *)
      echo "❌ Unknown argument: $arg (use patch|minor|major, --ios-only, --android-only)"
      exit 1
      ;;
  esac
done

APP_JSON="apps/mobile/app.json"

cd "$(git rev-parse --show-toplevel)"

# --- Validate local build toolchain before touching anything ---
for cmd in jq fastlane pod; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ Missing required tool: $cmd"
    exit 1
  fi
done
if [[ " ${PLATFORMS[*]} " == *" android "* && -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
  echo "❌ ANDROID_HOME or ANDROID_SDK_ROOT must be set for Android builds."
  exit 1
fi

# --- Validate clean working tree ---
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# --- Read current version + build number ---
CURRENT_VERSION=$(jq -r '.expo.version' "$APP_JSON")
CURRENT_BUILD_NUMBER=$(jq -r '.expo.ios.buildNumber' "$APP_JSON")
echo "📦 Current version: $CURRENT_VERSION (build $CURRENT_BUILD_NUMBER)"

# --- Bump version ---
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
NEW_BUILD_NUMBER=$((CURRENT_BUILD_NUMBER + 1))
echo "🔼 Bumping to: $NEW_VERSION (build $NEW_BUILD_NUMBER)"

# --- Update app.json (version + shared iOS/Android build number) ---
jq --arg v "$NEW_VERSION" --arg bn "$NEW_BUILD_NUMBER" \
  '.expo.version = $v | .expo.ios.buildNumber = $bn | .expo.android.versionCode = ($bn | tonumber)' \
  "$APP_JSON" > "$APP_JSON.tmp" && mv "$APP_JSON.tmp" "$APP_JSON"

# --- Commit the version bump ---
git add "$APP_JSON"
git commit -m "chore: bump version to $NEW_VERSION for release"
echo "✅ Committed version bump"

# --- Deploy Convex backend to production ---
echo "⚡ Deploying Convex backend to production..."
npx convex deploy
echo "✅ Convex backend deployed"

# --- Build locally + submit each platform ---
cd apps/mobile
mkdir -p build

for platform in "${PLATFORMS[@]}"; do
  if [[ "$platform" == "ios" ]]; then
    ARTIFACT="build/bondfires-$NEW_VERSION.ipa"
  else
    ARTIFACT="build/bondfires-$NEW_VERSION.aab"
  fi

  echo ""
  echo "🔨 Building $platform locally (this runs on your machine — no EAS queue)..."
  npx eas-cli build \
    --platform "$platform" \
    --profile production \
    --local \
    --non-interactive \
    --output "$ARTIFACT"
  echo "✅ $platform build complete: $ARTIFACT"

  echo "📤 Submitting $platform build..."
  npx eas-cli submit \
    --platform "$platform" \
    --profile production \
    --path "$ARTIFACT" \
    --non-interactive
  echo "✅ $platform submitted"
done

echo ""
echo "🎉 Release $NEW_VERSION (build $NEW_BUILD_NUMBER) built and submitted!"
echo "   iOS:     https://appstoreconnect.apple.com/apps/6755933598/testflight/ios"
echo "   Android: Google Play Console — internal testing track"
echo ""
echo "⚠️  Do not force-update users until the new version is live in both stores."
echo "   After App Store Connect and Google Play can serve $NEW_VERSION, run:"
echo "   npx convex run publicConfig:setMinVersion '{\"version\":\"$NEW_VERSION\"}'"
