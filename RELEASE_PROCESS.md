# Bondfires Release Process

> Crash monitoring, environment isolation, staging smoke tests, device gates, alerts,
> and rollback guidance are defined in
> [`docs/production-observability-and-release-qa.md`](docs/production-observability-and-release-qa.md).
> Production automation fails before versioning if Sentry/source-map configuration
> or the registered Convex target is missing or mismatched.

This is the source of truth for production mobile releases. The release script owns repeatable
mechanics; this document focuses on decisions and runtime checks that automation cannot prove.

## Before releasing

### 1. Review the change-specific impact

```bash
yarn repo:impact --base origin/main --head HEAD
```

Complete the relevant review and smoke-test actions in the report. In particular:

- Confirm Convex schema and public-function changes remain compatible with mobile versions already
  installed in production. Convex deploys before the new native builds are submitted.
- Exercise affected device-only behavior such as recording, notifications, deep links, billing,
  permissions, and light/dark themes.
- Review affected external contracts such as Mux, APNs, FCM, app-store billing, universal links,
  email, and AI providers.
- For a billing change, complete the provider setup, health check, and replay review in
  [`docs/store-billing-lifecycle.md`](docs/store-billing-lifecycle.md). Confirm App Store Server
  Notifications V2 and authenticated Google RTDN are healthy before releasing the client.
- For native capabilities or entitlements, confirm that signing credentials and provisioning
  profiles include the change.

Use the dedicated test account from `AGENTS.md` for low-impact production QA. The app targets the
production Convex deployment by default, so avoid destructive or broadly visible test data.

### 2. Confirm release access

The release machine needs:

- EAS authentication and valid iOS/Android signing credentials (used for signing and store upload, not for compiling)
- App Store Connect and Google Play submission access
- `jq`, `fastlane`, CocoaPods, Xcode, and the Android SDK/JDK
- `ANDROID_HOME` or `ANDROID_SDK_ROOT` when releasing Android

## Automated preflight

Every release runs `yarn validate` before changing `app.json`, creating a commit, or touching
production. Pull requests run the same command in CI.

The automated gate covers:

- Workspace typechecking and the complete unit-test suite
- Non-mutating Biome checks
- Offline Convex API module-registry parity; authenticated releases also perform full codegen
- Centralized route usage and unsafe route-cast detection
- Registered environment-variable ownership and required production build configuration
- Matching iOS/Android build numbers and deep-link hosts
- Offline App Links contract checks for package, hosts, path prefixes, Apple app ID, and
  certificate-fingerprint syntax
- Repository intelligence coverage and known operational-documentation drift

Run `yarn validate` directly when diagnosing a failure. The release command runs it again so the
production path never depends on a remembered manual checklist.

### App Links release gate

Android releases additionally run `yarn check:app-links:live` before changing the version or
touching production. The live check requires both `bondfires.org` and `bondfires.app` to serve,
without redirects:

- valid `application/json` association files;
- an `org.bondfires` Digital Asset Links statement containing the **Google Play App Signing**
  SHA-256 certificate;
- the Apple app ID and all invite/personal-Bondfire paths; and
- successful browser fallbacks for every supported path shape.

The signing fingerprint is public metadata, not a secret. Commit it to
`apps/mobile/app-links.json` once copied from Google Play Console, or temporarily supply it as a
comma-separated `BONDFIRES_PLAY_APP_SIGNING_SHA256` environment variable. Do not use the local AAB
or EAS upload-key fingerprint as a substitute: Google re-signs production installs with the Play
App Signing key.

Source of truth: **Google Play Console → Protected with Play → Play app signing → App signing key
certificate → SHA-256 certificate fingerprint**. The Play Console Digital Asset Links snippet on
that page is also authoritative.

## Local build, then submit

Production binaries are always compiled on this machine. Never queue an EAS cloud
build (`eas build` without `--local`) for a store release — that path sits in
Expo's build queue and takes ages.

The required order is:

1. **Build locally** with `eas build --local`. This produces the `.ipa` / `.aab`
   on disk. Signing credentials still come from EAS; the compile does not.
2. **Submit** that artifact with `eas submit --path <artifact>`. EAS is only the
   upload transport to App Store Connect and Google Play internal testing.

`yarn release` does both steps in that order. Do not run a production
`eas build` without `--local`, and do not submit an artifact you did not just
build locally.

## Release commands

Run releases from the repository root with a clean working tree:

```bash
eas env:exec production 'yarn release'        # patch; iOS + Android
eas env:exec production 'yarn release:minor'  # minor; iOS + Android
eas env:exec production 'yarn release:major'  # major; iOS + Android

eas env:exec production 'yarn release --ios-only'
eas env:exec production 'yarn release --android-only'
```

The wrapper loads the production EAS environment into the local release process;
the preflight rejects missing Sentry/source-map settings or a mismatched Convex URL.

The script:

1. Validates the local toolchain, clean working tree, and repository.
2. Increments the app version and shared iOS/Android build number in `apps/mobile/app.json`.
3. Commits the version change.
4. Starts an ignored evidence manifest at `apps/mobile/build/release-<version>.json`.
5. Deploys Convex to production.
6. Builds the requested native platforms locally (`eas build --local`).
7. Submits those local artifacts (`eas submit --path`) to App Store Connect and/or
   Google Play internal testing.
8. Records build, submission, completion, or failure events in the evidence manifest.

The evidence manifest is local and ignored by Git. Copy it elsewhere if a durable release record is
needed.

## After submission

1. Inspect the release evidence manifest and confirm every requested platform was submitted.
2. Check the Convex dashboard and logs for deployment or runtime errors.
3. Confirm the iOS build processes successfully in App Store Connect.
4. Confirm the Android build is available on the Google Play internal testing track.
5. Install the store-served builds and smoke-test the affected critical paths.
6. Monitor application telemetry and user reports closely for the first 24 hours.
7. For billing releases, run `storeBilling:billingHealth` from the Convex dashboard Function Runner
   with an admin identity after the first notification and reconciliation cycle; investigate any
   failed events or overdue records.

For Android, test a build installed from a Play track—not a locally signed AAB/APK. With the device
online, reset and re-run domain verification:

```bash
adb shell pm set-app-links --package org.bondfires 0 all
adb shell pm verify-app-links --re-verify org.bondfires
# Wait a few minutes for the verifier, then both hosts must say "verified":
adb shell pm get-app-links org.bondfires
adb shell pm get-app-links --user cur org.bondfires

# Do not force the package; this proves Android selects Bondfires as the default handler.
adb shell am start -W -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE \
  -d 'https://bondfires.app/invite/app-link-check'
adb shell am start -W -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE \
  -d 'https://bondfires.org/invite/camp/app-link-check'
adb shell am start -W -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE \
  -d 'https://bondfires.app/invite/family/app-link-check'
adb shell am start -W -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE \
  -d 'https://bondfires.app/personal-bondfire/app-link-check/app-link-check'
```

Each `am start` result must resolve to an `org.bondfires` activity without a browser or chooser.
Uninstall any development build using the same package before this test; Android can associate only
one installed app with a domain at a time.

## Force-update gating

The release script intentionally does not change `minAppVersion`. Enable a force update only after
the exact version is downloadable from both stores; otherwise existing clients can be locked out
without an available upgrade.

Sign in with an administrator account, open **Profile → Admin Panel → App Update Policy**, choose
the exact store version and update behavior, and confirm the warning. The backend independently
verifies the administrator session, validates the version, and writes an audit entry. Anonymous CLI
calls are intentionally rejected.

## Failure recovery

The release flow is not resumable. If it fails after the version commit:

1. Read `apps/mobile/build/release-<version>.json` to find the last successful action.
2. Determine whether either store received the version before retrying.
3. Fix the underlying issue and run `yarn validate`.
4. Choose deliberately between manually completing the interrupted version or starting a new
   patch release. Running `yarn release` again creates another version commit.

For an iOS capability/provisioning mismatch, run
`./scripts/refresh-ios-provisioning-profile.sh`, or replace the production provisioning profile via
`eas credentials -p ios`. Keep `ios.associatedDomains` and `ios.entitlements` aligned in
`apps/mobile/app.json`.

## Emergency hotfix

1. Fix the smallest safe surface and add a regression test when practical.
2. Review `yarn repo:impact` and complete its runtime checks.
3. Run `yarn release` for a patch release.
4. Verify the store-served build and monitor production closely.
5. Apply force-update gating only after both stores serve the hotfix.

---

**Established:** 2026-02-19 after a navigation routing failure reached users

**Last updated:** 2026-08-13 — local production builds required; EAS is submit-only
