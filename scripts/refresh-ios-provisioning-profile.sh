#!/bin/bash
# After adding iOS capabilities (e.g. Associated Domains), delete the stale App Store
# provisioning profile so the next EAS build creates one that includes the new entitlements.
#
# Usage: ./scripts/refresh-ios-provisioning-profile.sh

set -euo pipefail

cat <<'EOF'
Refresh iOS App Store provisioning profile (org.bondfires)

1. From apps/mobile, run:
     eas credentials -p ios

2. Select build profile: production

3. Choose: Build Credentials → Manage everything needed to build your project

4. Choose: Provisioning Profile: Delete one from your project → confirm

5. Re-run the release build:
     cd apps/mobile && yarn build:ios:prod
   Or from repo root: yarn release (after version bump / clean tree as usual)

Optional: In Apple Developer → Identifiers → org.bondfires, confirm "Associated Domains"
is enabled. EAS usually syncs this from app.json on the next build.

EOF
