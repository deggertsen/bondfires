# Bondfires 🔥

A video sharing social app where users create "bondfires" (video posts) and others respond with their own videos to build meaningful connections.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Mobile Framework | React Native (Expo) |
| UI Components | Tamagui |
| State Management | Legend State |
| Backend/Database | Convex |
| Authentication | Convex Auth |
| Navigation | Expo Router |
| Video Streaming | Bunny.net Stream |
| Image / Legacy Video Storage | AWS S3 |
| Video Metadata | react-native-compressor |
| Monorepo | Turborepo |
| Package Manager | Yarn |
| Infrastructure | Terraform |

## Repository Structure

```
bondfires/
├── apps/
│   └── mobile/              # Expo mobile app
├── packages/
│   ├── ui/                  # Shared Tamagui components
│   ├── app/                 # Features, hooks, Legend State stores
│   └── config/              # Tamagui configuration
├── convex/                  # Convex backend
├── infrastructure/          # Terraform for AWS
└── package.json
```

## State Management

This project uses [Legend State v3](https://legendapp.com/open-source/state/v3/) for reactive state management.

### Key Patterns

- **Global stores** (`packages/app/src/store/`) for persistent and shared state
- **`useObservable`** for local component state (3+ related values)
- **`useValue`** to subscribe to observable changes
- **`useObserve`/`useObserveEffect`** instead of `useEffect` for reactive side effects
- **`useState`** is acceptable for simple 1-2 field forms

See `.claude/CLAUDE.md` or `.cursor/rules/legend-state.mdc` for detailed patterns.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Yarn](https://yarnpkg.com/) (via Corepack: `corepack enable`)
- [tmux](https://github.com/tmux/tmux) for the dev scripts (`brew install tmux` or `apt install tmux`)
- [Android Studio](https://developer.android.com/studio) (for Android development)
- [Xcode](https://developer.apple.com/xcode/) (for iOS development, Mac only)
- [Convex](https://convex.dev/) account

### Installation

```bash
# Clone the repository
git clone https://github.com/deggertsen/bondfires.git
cd bondfires

# Enable Corepack (for Yarn)
corepack enable

# Install dependencies
yarn install

# Set up Convex backend
yarn dlx convex dev
```

### Environment Variables

Create a `.env.local` file in the root:

```env
EXPO_PUBLIC_CONVEX_URL=your-convex-deployment-url
```

Set these in the Convex dashboard for video and image storage:

```env
# Bunny.net Stream for new bondfire videos
BUNNY_STREAM_API_KEY=your-stream-library-api-key
BUNNY_STREAM_LIBRARY_ID=your-stream-library-id
BUNNY_STREAM_CDN_BASE_URL=https://your-stream-pull-zone.b-cdn.net
BUNNY_STREAM_COLLECTION_ID=optional-collection-id
BUNNY_STREAM_LOW_RESOLUTION=360
BUNNY_STREAM_THUMBNAIL_TIME_MS=1000

# S3 remains required for profile photos and legacy S3 video playback
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET_NAME=your-bucket
```

### Development Setup

**Important:** This app uses native modules and requires a development build. You **cannot** use Expo Go.

#### Running the App

From the project root, run everything with a single command:

```bash
# Android + Convex (uses tmux)
yarn dev:android

# iOS + Convex (uses tmux)
yarn dev:ios
```

This starts both the Convex backend and the Expo dev server in a split tmux session. On first run, it will build the native app locally and install it on your device/emulator.

**tmux controls:**
- `Ctrl+B` then `↑/↓` — Switch panes
- `Ctrl+B` then `d` — Detach (processes keep running)
- `tmux attach -t bondfires-dev` — Reattach

#### Building Manually (Optional)

If you need to rebuild the native app separately:

```bash
cd apps/mobile

# Android (requires Android Studio)
yarn android

# iOS (requires Xcode, Mac only)
yarn ios
```

## Features

- **Spark a Bondfire** - Record and share video posts
- **Respond to Bondfires** - Add video responses to existing posts
- **Algorithmic Feed** - Discover content ordered by engagement
- **User Profiles** - View and edit your profile
- **Push Notifications** - Stay updated on responses

## Releasing to App Stores

One command to bump version, build both platforms, and auto-submit:

```bash
# Patch release (1.0.3 → 1.0.4) — most common
yarn release

# Minor release (1.0.3 → 1.1.0)
yarn release:minor

# Major release (1.0.3 → 2.0.0)
yarn release:major
```

This runs `scripts/release.sh` which:
1. Bumps the version in `app.json`
2. Commits the version bump
3. Kicks off EAS production builds for iOS + Android
4. Auto-submits to App Store Connect and Google Play when builds finish

**Requirements:** Clean git tree, `eas-cli` installed and logged in.

**Notes:**
- Build numbers (iOS `buildNumber`, Android `versionCode`) auto-increment via EAS remote versioning
- The `version` string in `app.json` must be bumped for each store submission (stores reject duplicate versions)
- Android submits to the `internal` track as a draft
- iOS submits to App Store Connect (you still need to submit for review from there)

Monitor builds at: https://expo.dev/accounts/deggertsen/projects/bondfires/builds

## License

MIT
