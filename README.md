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
| Video Storage | AWS S3 |
| Video Processing | react-native-compressor |
| Monorepo | Turborepo |
| Package Manager | Bun |
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

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Node.js](https://nodejs.org/) >= 18
- iOS Simulator (Mac) or Android Emulator/Device
- [Convex](https://convex.dev/) account
- [EAS CLI](https://docs.expo.dev/build/setup/) for building development clients
  ```bash
  npm install -g eas-cli
  ```

### Installation

```bash
# Clone the repository
git clone https://github.com/deggertsen/bondfires.git
cd bondfires

# Install dependencies
bun install

# Set up Convex backend
bunx convex dev
```

### Environment Variables

Create a `.env.local` file in the root:

```env
EXPO_PUBLIC_CONVEX_URL=your-convex-deployment-url
```

### Development Setup

**Important:** This app uses native modules that require a custom development build. You **cannot** use Expo Go.

#### Step 1: Build Development Client

First, build and install a development client on your device/emulator:

```bash
cd apps/mobile

# Login to EAS (first time only)
eas login

# Build for Android
bun run build:android:dev

# OR build for iOS (simulator)
bun run build:ios:dev:sim

# OR build for iOS (physical device)
bun run build:ios:dev
```

After the build completes, download and install the APK (Android) or app bundle (iOS) on your device/emulator.

#### Step 2: Start Development Server

Once the development client is installed, start the Metro bundler:

```bash
# From apps/mobile directory
bun run start

# Or from root using Turborepo
bun run dev
```

The app should automatically connect to your development server.

### Quick Start (After Initial Setup)

Once you have a development client installed:

```bash
# Start the dev server
cd apps/mobile
bun run start
```

## Features

- **Spark a Bondfire** - Record and share video posts
- **Respond to Bondfires** - Add video responses to existing posts
- **Algorithmic Feed** - Discover content ordered by engagement
- **User Profiles** - View and edit your profile
- **Push Notifications** - Stay updated on responses

## License

MIT

