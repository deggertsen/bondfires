# Bondfires Mobile App

React Native (Expo) mobile application for Bondfires - a video response social platform.

## Prerequisites

- Node.js 18+
- Bun package manager
- Xcode 15+ (for iOS)
- Android Studio (for Android)
- EAS CLI: `npm install -g eas-cli`

## Setup

1. **Install dependencies**
   ```bash
   cd apps/mobile
   bun install
   ```

2. **Configure EAS** (first time only)
   ```bash
   eas login
   eas build:configure
   ```
   
   This will prompt you to create an EAS project and update `app.json` with your project ID.

3. **Set up environment variables**
   
   Create `.env` file with your Convex deployment URL:
   ```
   EXPO_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
   ```

## Development Builds

### iOS Simulator
```bash
# Build dev client for iOS simulator
eas build --profile development-simulator --platform ios

# After build completes, download and install the .app
# Then start the dev server:
bun start
```

### iOS Device
```bash
# Build dev client for physical iOS device
eas build --profile development --platform ios

# Install via QR code from EAS dashboard
# Then start the dev server:
bun start
```

### Android
```bash
# Build dev client APK
eas build --profile development --platform android

# Install the APK on your device/emulator
# Then start the dev server:
bun start
```

## Local Development (after dev client is installed)

```bash
# Start Metro bundler
bun start

# Or with cache clear
bun start --clear
```

## Native Code Changes

If you add or update native modules, you need to rebuild the dev client:

```bash
# iOS
eas build --profile development-simulator --platform ios

# Android
eas build --profile development --platform android
```

## Production Builds

```bash
# iOS App Store build
eas build --profile production --platform ios

# Android Play Store build
eas build --profile production --platform android
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
- `ffmpeg-kit-react-native` - Video compression
- `react-native-mmkv` - Fast local storage

These modules **cannot** run in Expo Go. You must use a development build.

## Troubleshooting

### Build fails with CocoaPods error
```bash
cd ios && pod install --repo-update && cd ..
```

### Metro bundler cache issues
```bash
bun start --clear
# or
npx expo start -c
```

### ffmpeg-kit issues on iOS
Make sure you're on iOS 15.1+ (set in `expo-build-properties` plugin).

### MMKV issues
Ensure `metro.config.js` includes `'cjs'` in `sourceExts`.

