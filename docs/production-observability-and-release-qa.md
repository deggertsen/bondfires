# Production observability and release QA

This is the operational contract for Bondfires native releases. It is intentionally
fail-closed: a production artifact without crash monitoring, or a preview artifact
without a separate Convex deployment, is not releasable.

The integration follows Expo's official [Sentry guide](https://docs.expo.dev/guides/using-sentry/),
including the Expo config plugin, Sentry-aware Metro configuration, and
`SENTRY_AUTH_TOKEN` source-map upload. EAS profiles explicitly select one of Expo's
[development, preview, or production environments](https://docs.expo.dev/eas/environment-variables/),
and update commands must pass `--environment` as described by Expo's
[EAS environment usage guide](https://docs.expo.dev/eas/environment-variables/usage/).

## Owner setup required before the first preview or production build

No external project or credential is created by this repository change.

1. Create a Sentry React Native project and record its organization slug, project
   slug, DSN, and organization auth token. Expo documents these exact inputs and
   recommends Sensitive visibility for `SENTRY_AUTH_TOKEN`.
2. In EAS, set the following separately for the `preview` and `production`
   environments:

   | Variable | Visibility | Purpose |
   | --- | --- | --- |
   | `EXPO_PUBLIC_APP_ENV` | Plain text | Must match `preview` or `production` |
   | `EXPO_PUBLIC_CONVEX_URL` | Plain text | Dedicated deployment URL; preview must not equal production |
   | `EXPO_PUBLIC_MUX_DATA_ENV_KEY` | Plain text | Mux Data environment owned by that runtime |
   | `EXPO_PUBLIC_SENTRY_DSN` | Plain text | Public client ingestion endpoint |
   | `SENTRY_ORG` | Plain text or Sensitive | Source-map organization slug |
   | `SENTRY_PROJECT` | Plain text or Sensitive | Source-map project slug |
   | `SENTRY_AUTH_TOKEN` | Sensitive | Build-only source-map upload credential; never `EXPO_PUBLIC_` |
   | `SENTRY_NATIVE_PRIVACY_REVIEWED` | Plain text | Set to `true` only after the native privacy review below |

3. Create a non-production Convex deployment and a dedicated staging test account.
   The repository deliberately contains no guessed staging URL or credentials.
4. Configure Sentry alerts and link Sentry to EAS if desired. Expo documents the
   [EAS dashboard integration](https://docs.expo.dev/guides/using-sentry/#sentry-integration-with-eas-dashboard).
5. Before enabling Sentry in production, have the owner/legal reviewer update the
   public privacy policy and the Apple App Privacy and Google Play Data Safety
   declarations for crash/diagnostic collection, retention, and sharing. Record the
   decision on Sentry's processor/subprocessor role, data-processing terms, region,
   and retention. This repository does not make those legal declarations for the
   business.

To load EAS values locally without committing them, use `eas env:pull --environment
preview` or `eas env:exec`. Do not copy the production `.env` into a preview or
development build.

## What is and is not collected

Sentry is disabled when `EXPO_PUBLIC_SENTRY_DSN` is absent. Production preflight
requires it. Enabled builds collect native crashes, fatal JavaScript errors,
automatic sessions, iOS watchdog termination/app-hang signals, Android native
crash/ANR signals supplied by the native SDK, app version/build, OS/device family,
and symbolicated stacks.

The client sets `sendDefaultPii: false` and disables screenshots, view hierarchy,
replay, tracing, profiling, and JavaScript failed-request capture. JavaScript
`beforeSend`/`beforeBreadcrumb` allowlist context, remove arbitrary containers, and
redact common email, DOB, credential, invite, and URL formats. Stack/debug-image
locations retain matching filenames but discard hostnames, directories, and query
strings. This is defense in depth, not a guarantee that arbitrary text is non-personal.
The Convex queue scrubs new entries, restored entries, and synchronous crash breadcrumbs
before persistence and again before upload, preserving byte limits and local account isolation.

**Native privacy gate:** the React Native SDK does not forward JavaScript `beforeSend`
or `beforeBreadcrumb` callbacks to its native SDKs. Native crash, ANR, hang, and session
payloads therefore do not have the JavaScript scrubber's guarantee. Before production,
capture staging iOS and Android native events, review their actual payloads and native
breadcrumbs, configure and verify Sentry server-side scrubbing/retention, and approve the
remaining collection in the public policy and store declarations. Only then set
`SENTRY_NATIVE_PRIVACY_REVIEWED=true`; production preflight and EAS config reject its
absence. This setting is an owner attestation, not an automatic privacy verification.
Do not add Sentry `setUser`, arbitrary `extra`, request bodies, or media attachments.

## Environment and release preflight

Every EAS profile declares both its EAS `environment` and bundled
`EXPO_PUBLIC_APP_ENV`. The production Convex URL is registered exactly; other
environments are rejected if they equal it. Preview currently has no URL in source,
so this expected command fails with the exact owner action until staging exists:

```bash
node scripts/mobile-release-preflight.mjs --profile preview
```

After the owner provisions the preview environment, verify it with its EAS values
loaded into the command process:

```bash
eas env:exec preview \
  'node scripts/mobile-release-preflight.mjs --profile preview'
```

For production, run with the matching EAS variables in the process:

```bash
eas env:exec production \
  'node scripts/mobile-release-preflight.mjs --profile production'
```

`scripts/release.sh` runs the same production preflight before versioning, Convex
deployment, native builds, or store submissions. After a build, confirm its Sentry
event has `environment=production`, release `org.bondfires@<version>`, the native
build number as `dist`, and a symbolicated in-app frame. Source maps must upload
during the build; Expo notes that `SENTRY_AUTH_TOKEN` is required in the build
environment and Sentry cannot retroactively symbolicate events captured before
artifacts arrive.

Production rejects `SENTRY_DISABLE_AUTO_UPLOAD` and `SENTRY_ALLOW_FAILURE` bypasses.
Local development also needs a dedicated backend: the old production-targeting `.env`
will now fail environment validation rather than silently access production.

## Maestro smoke suite

Install Maestro using its [official installation instructions](https://docs.maestro.dev/getting-started/installing-maestro).
Build/install a **preview** binary, point it at staging, and provide only staging
credentials:

```bash
export MAESTRO_TEST_EMAIL='<staging account>'
export MAESTRO_TEST_PASSWORD='<staging password>'
yarn smoke:mobile
```

The flows cover signed-out launch and deep-link routing, non-destructive sign-in,
Home/Camps/Profile navigation, Terms/Privacy/Community Guidelines and Delete Account entry points,
and sign-out. They do not create camps, publish video, redeem a valid invite, buy a
subscription, or mutate production. Reset the staging account between release
candidates by deleting only test-created staging records through an owner-reviewed
staging admin procedure; never run a reset against the production deployment.

CI runs a deterministic drift check for flow files, package/config privacy guards,
profile mappings, and prohibited production URLs/credentials. Simulator/device
execution remains a release-candidate gate because GitHub CI has no signed native
binary or staging account.

## Device-only release gates

Complete on both a physical iPhone and supported physical Android device against
staging before store submission:

- confirm the published privacy policy and both store privacy declarations match
  the enabled Sentry fields and the approved processor/subprocessor decision;

- record, cancel, retry, publish, playback, response, local-backup recovery, and a
  short live stream with camera/microphone permission denial and recovery;
- background/foreground live recording and network-loss recovery;
- sandbox/TestFlight and Play internal-track purchase, restore, renewal-state sync,
  and cancellation guidance—never a real production purchase;
- APNs/FCM permission, token registration, foreground/background delivery, tap
  routing, category preferences, and revoked-permission recovery;
- universal/app links for both hosts, an invalid invite, and an authenticated valid
  staging invite;
- light/dark theme, account deletion entry point, report/block, family age-boundary
  and privacy/terms surfaces, and sign-out cleanup;
- one intentional preview-only test exception, followed by verification that its
  event is scrubbed and symbolicated. Remove the test trigger before release.

## Alerts, launch watch, and rollback

Configure these in Sentry; repository code cannot create project alerts safely:

- immediate notification for any new production fatal/native crash issue;
- warning when crash-free sessions fall below the agreed launch SLO, with a paging
  threshold below that; choose the numeric SLO after a preview/internal baseline;
- new or materially increased Android ANR/iOS app-hang/watchdog issues;
- error-event volume materially above the seven-day baseline;
- source-map/debug-file upload failure in the build pipeline;
- environment/release mismatch (preview event in production or unknown release).

For the first 24 hours, watch after each phased-store rollout increase. Halt rollout
on a fatal regression, protect incompatible backend changes, and ship a corrected
build. Do not raise `minAppVersion` until both stores can serve the fix. Native store
artifacts cannot be instantly rolled back. This project does not currently declare
`expo-updates` or a `runtimeVersion`, so an EAS Update is not an available emergency
rollback path. If OTA updates are deliberately enabled later, require runtime
compatibility, the correct `--environment`, and Sentry source-map upload as part of
that separate rollout design. Record the decision and evidence manifest before
resuming rollout.
