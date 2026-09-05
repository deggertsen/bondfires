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
REPO_ROOT=$(pwd)

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

# --- Deterministic preflight before changing version or production state ---
echo "🔎 Running repository validation and release preflight..."
node scripts/mobile-release-preflight.mjs --profile production
CONVEX_CODEGEN_FULL=1 yarn validate
if [[ " ${PLATFORMS[*]} " == *" android "* ]]; then
  echo "🔗 Verifying live Android App Links against the Play App Signing certificate..."
  yarn check:app-links:live
fi
echo "✅ Release preflight passed"

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

# --- Start an ignored release-evidence manifest ---
CONVEX_URL=$(jq -r '.build.production.env.EXPO_PUBLIC_CONVEX_URL' apps/mobile/eas.json)
RELEASE_MANIFEST="apps/mobile/build/release-$NEW_VERSION.json"
mkdir -p apps/mobile/build

EVIDENCE_INIT_ARGS=(
  init
  --manifest "$RELEASE_MANIFEST"
  --version "$NEW_VERSION"
  --build-number "$NEW_BUILD_NUMBER"
  --convex-url "$CONVEX_URL"
)
for platform in "${PLATFORMS[@]}"; do
  EVIDENCE_INIT_ARGS+=(--platform "$platform")
done
node scripts/release-evidence.mjs "${EVIDENCE_INIT_ARGS[@]}"

record_release_failure() {
  local status=$?
  set +e
  node "$REPO_ROOT/scripts/release-evidence.mjs" event \
    --manifest "$RELEASE_MANIFEST" \
    --name release-failed \
    --detail "release.sh exited with status $status"
  exit "$status"
}
trap record_release_failure ERR

# --- Deploy Convex backend to production ---
echo "⚡ Deploying Convex backend to production..."
npx convex deploy
node "$REPO_ROOT/scripts/release-evidence.mjs" event \
  --manifest "$RELEASE_MANIFEST" \
  --name convex-deployed
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
  node "$REPO_ROOT/scripts/release-evidence.mjs" event \
    --manifest "$RELEASE_MANIFEST" \
    --name platform-built \
    --platform "$platform" \
    --artifact "apps/mobile/$ARTIFACT"
  echo "✅ $platform build complete: $ARTIFACT"

  echo "📤 Submitting $platform build..."
  npx eas-cli submit \
    --platform "$platform" \
    --profile production \
    --path "$ARTIFACT" \
    --non-interactive
  node "$REPO_ROOT/scripts/release-evidence.mjs" event \
    --manifest "$RELEASE_MANIFEST" \
    --name platform-submitted \
    --platform "$platform" \
    --artifact "apps/mobile/$ARTIFACT"
  echo "✅ $platform submitted"
done

cd ../..
node "$REPO_ROOT/scripts/release-evidence.mjs" event \
  --manifest "$RELEASE_MANIFEST" \
  --name release-complete
trap - ERR

echo ""
echo "🎉 Release $NEW_VERSION (build $NEW_BUILD_NUMBER) built and submitted!"
echo "   Evidence: $RELEASE_MANIFEST"
echo "   iOS:     https://appstoreconnect.apple.com/apps/6755933598/testflight/ios"
echo "   Android: Google Play Console — internal testing track"
echo ""
echo "⚠️  Do not force-update users until the new version is live in both stores."
echo "   After App Store Connect and Google Play can serve $NEW_VERSION, use"
echo "   Profile → Admin Panel → App Update Policy in a store-served admin build."
