# Bondfires Mobile App

The React Native (Expo) client for Bondfires. It uses native modules and the custom
`bondfire-live-publisher`, so it cannot run in Expo Go.

## Prerequisites

- Node.js 18+ and Yarn through Corepack
- A Convex deployment URL
- Xcode and CocoaPods for iOS development
- Android Studio, the Android SDK, and a JDK for Android development
- `tmux` for the repository-level `dev:ios` and `dev:android` commands

EAS authentication is needed only for cloud development builds, credentials, and production
submission.

## Setup

From the repository root:

```bash
corepack enable
yarn install
cp apps/mobile/.env.example apps/mobile/.env
```

Set the client deployment in `apps/mobile/.env`:

```env
EXPO_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
```

Metro inlines `EXPO_PUBLIC_*` values at bundle time. Restart Metro with `--clear` after changing
them. Fresh Git worktrees do not inherit the ignored `.env`; copy it from the primary checkout or
recreate it from `.env.example` before launching the app.

Mux credentials and other provider secrets are server-side Convex environment variables, not
mobile `.env` values. See the root [`README.md`](../../README.md) and
[`docs/mux-setup.md`](../../docs/mux-setup.md). The Mux webhook endpoint is:

```text
https://<your-convex-deployment>.convex.site/mux/webhook
```

## Run locally

The repository-level helpers start Convex and the native Expo app in a split `tmux` session:

```bash
yarn dev:ios
yarn dev:android
```

They run `expo run:ios` or `expo run:android`, which builds and installs the native client when
needed. Useful `tmux` controls:

- `Ctrl+B`, then `↑` or `↓`: switch panes
- `Ctrl+B`, then `d`: detach while processes continue
- `tmux attach -t bondfires-dev`: reattach

If a compatible development client is already installed, Metro can be started independently:

```bash
cd apps/mobile
yarn start
yarn start --clear   # clear Metro caches when needed
```

## Cloud development builds

Cloud builds are useful for shared devices or when a local native toolchain is unavailable:

```bash
yarn workspace mobile build:android:dev
yarn workspace mobile build:ios:dev
yarn workspace mobile build:ios:dev:sim
```

Download and install the resulting APK or iOS app from EAS. Rebuild the development client after:

- Adding or updating a native dependency
- Changing Expo plugins, permissions, entitlements, or build properties
- Updating the Expo or React Native version
- Changing code in `modules/` or `targets/`

JavaScript and TypeScript-only changes normally require only a Metro reload.

## Production releases

Production versioning, validation, **local** builds, store submission, failure recovery, and
force-update gating are documented in the repository-level
[`RELEASE_PROCESS.md`](../../RELEASE_PROCESS.md). Use the root `yarn release` commands rather than
assembling production build and submission commands from this development guide. Production
`eas build` must always pass `--local`; cloud EAS builds are for development clients only.

## Structure

```text
apps/mobile/
├── app/                 # Expo Router screens and layouts
├── assets/              # Bundled images and fonts
├── components/          # Mobile-only UI and flows
├── lib/                 # Navigation and mobile helpers
├── modules/             # Custom Expo native modules
├── targets/             # Apple extension targets
├── test/                # Mobile unit tests
├── app.json             # Expo and native application configuration
├── eas.json             # EAS build and submission profiles
├── babel.config.js
├── metro.config.js
└── tamagui.config.ts
```

Shared state, hooks, services, and policies live in `packages/app`; reusable UI lives in
`packages/ui`.

## Troubleshooting

### Missing Convex client or URL

Confirm `apps/mobile/.env` exists and contains a canonical `https://*.convex.cloud` URL, then
restart Metro with `yarn start --clear`.

### Development client cannot reach Metro

1. Confirm the device and development machine can reach each other.
2. Confirm Metro is running and select the correct server in the Expo development menu.
3. For an Android emulator, run `adb reverse tcp:8081 tcp:8081` if necessary.

### Native build caches

For iOS CocoaPods failures:

```bash
cd apps/mobile/ios
pod install --repo-update
```

For Android Gradle cleanup:

```bash
yarn workspace mobile android:clean
```

### Video uploads

Verify the Convex Mux environment variables and webhook configuration in
[`docs/mux-setup.md`](../../docs/mux-setup.md). Confirm the app is a native development build, not
Expo Go.

### Watchman

```bash
watchman shutdown-server
cd apps/mobile
yarn start --clear
```

If Watchman remains unavailable, start Metro with `CI=true yarn start`.
