# Bondfires Mobile App

React Native (Expo) mobile application for Bondfires - a video response social platform.

## Prerequisites

Before running the app, ensure you have:

- **Node.js** 18+ and **Yarn** package manager (via Corepack: `corepack enable`)
- **EAS CLI** installed globally:
  ```bash
  npm install -g eas-cli
  ```
- **iOS development**: Xcode 15+ (macOS only)
- **Android development**: Android Studio with SDK and emulator/device
- **Convex account** and deployment URL

## Important: Development Builds Required

⚠️ **This app cannot run in Expo Go.** It uses native modules that require a custom development client:
- `expo-camera` - Video recording
- `expo-av` - Video playback
- `expo-notifications` - Push notifications
- `react-native-compressor` - Video/image compression (WhatsApp-like)
- `react-native-mmkv` - Fast local storage

You **must** build and install a development client before running the app.

## Initial Setup

### 1. Install Dependencies

```bash
cd apps/mobile
yarn install
```

### 2. Configure EAS (First Time Only)

```bash
# Login to your Expo account
eas login

# Configure the project (creates/updates app.json with project ID)
eas build:configure
```

### 3. Set Up Environment Variables

Create a `.env` or `.env.local` file in the project root with your Convex deployment URL:

```env
EXPO_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
```

### 4. Build Development Client

You need to build and install a development client on your target device/emulator **before** you can run the app:

#### For Android

```bash
# Build development client APK
yarn build:android:dev

# After build completes:
# 1. Download the APK from EAS dashboard
# 2. Install on your Android device/emulator:
#    - Device: Enable USB debugging and install via ADB
#    - Emulator: Drag APK into emulator window
```

#### For iOS Simulator

```bash
# Build development client for iOS simulator
yarn build:ios:dev:sim

# After build completes:
# 1. Download the .app file from EAS dashboard
# 2. Install: xcrun simctl install booted /path/to/app.app
#    OR drag the .app into Simulator
```

#### For iOS Physical Device

```bash
# Build development client for physical device
yarn build:ios:dev

# After build completes:
# 1. Scan QR code from EAS dashboard with your device camera
# 2. Install via TestFlight (if configured) or direct install
```

## Development Builds

After your development client is installed, you can develop normally:

Use the npm scripts for convenience:

```bash
# Android
yarn build:android:dev

# iOS Simulator
yarn build:ios:dev:sim

# iOS Device
yarn build:ios:dev
```

Or use EAS CLI directly:

```bash
# Android
eas build --platform android --profile development

# iOS Simulator
eas build --platform ios --profile development-simulator

# iOS Device
eas build --platform ios --profile development
```

## Running the App

**After the development client is installed**, start the development server:

```bash
# Start Metro bundler
yarn start

# Or with cache clear if you have issues
yarn start --clear
# or
npx expo start -c
```

The app should automatically connect to the development server. If it doesn't, shake your device/emulator to open the dev menu and select "Configure Bundler" to enter the server URL manually.

## When to Rebuild Development Client

Rebuild your development client when:

- Adding or updating native modules (e.g., `expo-camera`, `react-native-compressor`)
- Changing native configuration (e.g., `app.json` plugins, permissions)
- Updating Expo SDK version
- Changing build properties (e.g., `expo-build-properties`)

To rebuild:

```bash
# Use the build scripts
yarn build:android:dev
yarn build:ios:dev:sim
```

## Production Builds

```bash
# iOS App Store build
eas build --platform ios --profile production

# Android Play Store build
eas build --platform android --profile production
```

## Submitting to App Stores

First, update `eas.json` with your credentials:
- iOS: Apple ID, ASC App ID, Team ID
- Android: Service account key path

Then:
```bash
# Submit to App Store
eas submit --platform ios

# Submit to Play Store
eas submit --platform android
```

## Project Structure

```
apps/mobile/
├── app/                    # Expo Router screens
│   ├── (auth)/            # Authentication screens
│   ├── (main)/            # Main app screens (feed, create, profile)
│   └── _layout.tsx        # Root layout with providers
├── assets/                # Images, fonts, etc.
├── components/            # App-specific components
├── app.json               # Expo configuration
├── eas.json               # EAS Build configuration
├── babel.config.js        # Babel config (Tamagui)
├── metro.config.js        # Metro bundler config
└── tamagui.config.ts      # Tamagui theme config
```

## Native Modules Used

This app uses native modules that require a custom dev client:

- `expo-camera` - Video recording
- `expo-av` - Video playback
- `expo-notifications` - Push notifications
- `react-native-compressor` - Video/image compression
- `react-native-mmkv` - Fast local storage

These modules **cannot** run in Expo Go. You must use a development build.

## Troubleshooting

### Development client not connecting to Metro

1. Make sure your device/emulator and computer are on the same network
2. Check that Metro bundler is running
3. Shake device/emulator → Dev Menu → "Configure Bundler" → Enter correct URL
4. For Android emulator, use `adb reverse tcp:8081 tcp:8081` if needed

### Metro bundler cache issues

```bash
yarn start --clear
# or
npx expo start -c
```

### Build fails with CocoaPods error (iOS)

```bash
cd ios && pod install --repo-update && cd ..
```

### Android build issues

If you encounter dependency resolution errors, use EAS Build instead of local builds:
- EAS Build handles native dependencies more reliably
- Use `yarn build:android:dev` for cloud builds

### Video compression issues

This app uses `react-native-compressor` for video compression. If you encounter issues:

- Ensure you have a development build (not Expo Go)
- Check that native modules are properly linked
- Try cleaning and rebuilding: `yarn android:clean`

### MMKV issues

Ensure `metro.config.js` includes `'cjs'` in `sourceExts` (already configured).

### Watchman issues (Mac)

If Metro has Watchman connection issues:

```bash
watchman shutdown-server
# Then restart Metro
yarn start
```

Or bypass Watchman:
```bash
CI=true yarn start
```
