# Production observability and release QA

## Firebase Crashlytics setup

Bondfires uses React Native Firebase App + Crashlytics (26.4.0), not Sentry.
The committed public Firebase registrations both target `bondfires-c455d` and
`org.bondfires`. These are app configuration, not service-account credentials.
The separate Play submission key is not used by Crashlytics.

Before release, the owner must:

1. Open Firebase Console → `bondfires-c455d` → Crashlytics and finish onboarding
   for both registered apps; configure new-fatal/regression alerts and recipients.
2. Set `CRASHLYTICS_ENABLED=true` in the preview and production EAS environments.
   Set `MONITORING_NATIVE_PRIVACY_REVIEWED=true` in production only after the
   payload/privacy review below. Both are build-only, non-secret configuration.
   Remove obsolete Sentry variables if previously added; no Sentry account,
   DSN, upload token, organization or project is needed.
3. Keep distinct Convex deployments for development/preview and production.
   Set `EXPO_PUBLIC_APP_ENV`, `EXPO_PUBLIC_CONVEX_URL` and
   `EXPO_PUBLIC_MUX_DATA_ENV_KEY` in the matching EAS environment. Provision a
   staging account; never copy production credentials into staging smoke tests.
4. Build new native binaries: existing development clients do not contain RNFB.
   Preview uses the same Firebase project, with an `environment=preview` custom
   key; filter release monitoring appropriately. Use separate device installs
   for staging and production (or uninstall between environments): the bundle ID
   is shared and Firebase collection preferences persist across upgrades.

The official [RNFB Expo setup](https://rnfirebase.io/#expo) and
[Crashlytics integration](https://rnfirebase.io/crashlytics/usage) are the
integration references. We retain CocoaPods/static linkage (`disableSPM`) and
force-static-link the two RNFB modules to match Expo's prebuilt React Native.

## Privacy and collection

Native auto-collection and debug reporting default off in `apps/mobile/firebase.json`.
Approved preview/production runtimes enable collection after setting environment,
release and build keys. Development, Expo Go and web do not initialize the adapter.
First-launch crashes before JavaScript initialization may only upload on a later
successful launch. Once enabled, the native SDK can capture crashes before JS runs.

No Analytics SDK, user IDs, email attributes, replay, screenshots, arbitrary custom
logs or media attachments are added. JavaScript boundary/global/polyfill error
reports copy only scrubbed error text and bounded frames. RNFB's unsanitized JS
handlers are replaced while preserving the app's original fatal-error handling.
Hermes rejection tracking and application breadcrumbs remain in Convex telemetry.
Manually recorded JS errors appear as non-fatal reports; a genuine native fatal
may also appear separately. Crashlytics is not a replacement for backend/Mux logs.

Native crash/ANR payloads bypass JavaScript scrubbing. Review actual iOS/Android
preview payloads, installation identifiers, device data and retention against
Firebase's [privacy information](https://firebase.google.com/support/privacy).
Update the public privacy policy and Apple App Privacy / Play Data Safety answers
for the selected provider and actual collection. The privacy environment variable
is an owner attestation, not automated compliance verification or user consent.
If the review requires consent or collection restrictions, implement them before
enabling production; do not claim native payloads are anonymized by our JS scrubber.

## Build and symbol verification

Run with EAS variables loaded:

```bash
eas env:exec preview 'node scripts/mobile-release-preflight.mjs --profile preview'
eas env:exec production 'node scripts/mobile-release-preflight.mjs --profile production'
```

Production preflight requires monitoring enablement, native privacy approval,
matching Firebase app registrations and the registered Convex target. It cannot
prove console onboarding, alert delivery or symbol upload succeeded.

RNFB adds the iOS Crashlytics dSYM upload phase. The Android config plugin enables
NDK symbols and finalizes release assemble/bundle with the symbol-upload task;
the Firebase Gradle plugin handles Java/Kotlin mapping files. Inspect build logs
and resolve missing dSYMs/native symbols in Firebase before launch.

`yarn release` keeps local EAS working directories in
`apps/mobile/build/symbols/<version>-<platform>/` and requests an iOS Hermes map
via `SOURCEMAP_FILE`. Android Hermes maps live under the retained build's
`android/app/build/generated/sourcemaps/react/release/`. Archive these exact-build
maps and native symbols alongside the release evidence manifest. They are ignored
by Git, can be large, and must not be hosted publicly. Confirm each map exists;
do not substitute a map rebuilt later from similar source. Crashlytics does not
provide the previous Sentry JS source-map upload pipeline: use the matching map
with Metro symbolication for minified Hermes frames when investigating a report.

## Release-candidate gates

Install Maestro, build/install a preview binary and use staging credentials:

```bash
export MAESTRO_TEST_EMAIL='<staging account>'
export MAESTRO_TEST_PASSWORD='<staging password>'
yarn smoke:mobile
```

These non-destructive flows cover launch/deep links, sign-in, Home/Camps/Profile,
legal/deletion entry points and sign-out. CI validates their contracts, not actual
device execution. Complete these additional checks on physical iOS and Android:

- Record, cancel, retry, publish, playback, respond, recover a local backup and
  stream live; deny/regrant camera/microphone permissions and interrupt networking.
- Test background/foreground playback/recording and PiP.
- Test sandbox/TestFlight and Play internal-track purchase, restore and renewal.
- Test APNs/FCM permissions, delivery, preferences and tap routing.
- Test both link hosts from store-installed builds, valid/invalid staging invites,
  report/block, deletion, teen/family boundaries and light/dark themes.
- Temporarily trigger a scrubbed JS error and a native crash in preview only.
  Disconnect the debugger, relaunch, confirm both platforms report to Firebase
  with the correct version/build/environment, inspect privacy and symbolication,
  and verify an alert reaches the release owner. Remove test triggers before release.

## Launch watch and rollback

Monitor new fatal crashes, Android ANRs, regressions, crash-free users/sessions,
Convex action failures and Mux playback/upload errors. Choose launch thresholds
from an internal baseline; monitor after every phased-rollout increase for the
first 24 hours. Apple diagnostics remain complementary for iOS hangs/watchdogs.

Halt rollout on a fatal regression and ship a corrected local native build. Preserve
backend compatibility; do not raise `minAppVersion` until both stores serve the fix.
Native artifacts cannot be instantly rolled back. There is no configured
`expo-updates`/`runtimeVersion` OTA rollback path. Archive the release evidence and
symbols before resuming rollout. See [RELEASE_PROCESS.md](../RELEASE_PROCESS.md).
