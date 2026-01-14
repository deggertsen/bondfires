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

## Releasing to Production

### Production Environment

The production build profile is configured in `eas.json` with:

- **Production Convex URL**: `https://fleet-caiman-92.convex.cloud` (configured in build profile)
- **Auto-increment build numbers**: Enabled for both iOS and Android
- **Build distribution**: App Store (iOS) / Google Play (Android)

### Prerequisites

Before releasing, ensure you have:

1. **EAS account** logged in (`eas login`)
2. **App Store Connect access** (iOS)
3. **Google Play Console access** (Android)
4. **Credentials configured** (one-time setup, see below)

### Setting Up Credentials (First Time Only)

#### iOS Credentials

Configure code signing and App Store Connect credentials:

```bash
cd apps/mobile
eas credentials --platform ios
```

Follow the interactive prompts to:

- Set up distribution certificates and provisioning profiles
- Configure App Store Connect API key or Apple ID authentication
- The `eas.json` already has the Apple Team ID configured: `J8UCZDVZ8K`

#### Android Credentials

1. **Get Google Play Service Account Key**:

   **Step 1: Create Service Account in Google Cloud Console**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Make sure you're in the same Google account as your Play Console
   - In the left sidebar, go to **"IAM & Admin"** → **"Service Accounts"**
   - Click **"Create Service Account"** at the top
   - Enter a name (e.g., "play-console-submit") and description
   - Click **"Create and Continue"**
   - Skip role assignment (click **"Continue"**)
   - Click **"Done"** (no need to grant users access)

   **Step 2: Generate and Download the JSON Key**
   - Still in Google Cloud Console → IAM & Admin → Service Accounts
   - Find your newly created service account and click on it
   - Go to the **"Keys"** tab
   - Click **"Add Key"** → **"Create new key"**
   - Choose **JSON** format
   - Click **"Create"** - the JSON key file will download automatically
   - **Save this file as `google-services-key.json`** in `apps/mobile/` directory (already in `.gitignore`)

   **Step 3: Link Service Account to Google Play Console**
   - Go to [Google Play Console](https://play.google.com/console)
   - Select **"Users and permissions"**
   - Click **"Invite new users"** (or **"Add users"**)
   - Enter the service account email (format: `your-service-account-name@project-id.iam.gserviceaccount.com` - you can find this in Google Cloud Console)
   - Select **"Admin"** role (or grant permissions: "View app information", "Create, edit, and delete draft apps", "Release apps in testing tracks", "Release apps in production")
   - Click **"Send invitation"**
   - The service account will be linked to your Play Console

2. **Configure EAS credentials**:

   ```bash
   cd apps/mobile
   eas credentials --platform android
   ```

   Follow prompts to configure the upload key for signing (separate from the service account key).

### Building for Production

Use the convenient npm scripts:

```bash
# iOS production build
yarn build:ios:prod

# Android production build
yarn build:android:prod
```

Or use EAS CLI directly:

```bash
# iOS
eas build --platform ios --profile production

# Android
eas build --platform android --profile production
```

**Build Process:**

- Builds run on EAS Build servers (cloud)
- Build numbers are auto-incremented (iOS: `buildNumber`, Android: `versionCode`)
- Production environment variables are injected automatically
- Build artifacts are stored on EAS servers

### Submitting to App Stores

#### iOS - TestFlight

After the build completes, submit to TestFlight:

```bash
# Submit latest iOS build
yarn submit:ios

# Or manually
eas submit --platform ios --profile production
```

**Submission Process:**

- Uploads the build to App Store Connect
- Processing typically takes 10-30 minutes
- Once processed, build appears in TestFlight
- TestFlight builds can be distributed to internal/external testers

#### Android - Google Play Internal Testing

After the build completes, submit to Google Play Internal testing track:

```bash
# Submit latest Android build
yarn submit:android

# Or manually
eas submit --platform android --profile production
```

**Submission Process:**

- Uploads AAB to Google Play Console
- Processing typically takes 10-30 minutes
- Build appears in Internal Testing track (configured in `eas.json`)
- Can be distributed to internal testers immediately

### One-Command Release

For convenience, you can build and submit in one command:

```bash
# iOS: Build + Submit to TestFlight
yarn release:ios

# Android: Build + Submit to Google Play Internal
yarn release:android
```

**Note:** These commands will:

1. Build the app (10-20 minutes)
2. Wait for build completion
3. Automatically submit to the respective store
4. Submit may fail if build is still processing; wait a few minutes and run submit separately

### Release Checklist

Before each release:

- [ ] Update version number in `app.json` (if needed)
- [ ] Verify production Convex URL in `eas.json`
- [ ] Test the app locally with production environment
- [ ] Ensure credentials are configured (`eas credentials`)
- [ ] Build production version
- [ ] Submit to TestFlight/Play Store
- [ ] Monitor build processing in respective consoles
- [ ] Distribute to testers (TestFlight/Play Console)

### Version Management

- **Version numbers** (`version` in `app.json`): Update manually when releasing new features
- **Build numbers** (`buildNumber`/`versionCode`): Auto-incremented by EAS (configured in `eas.json`)
- **Remote version source**: Enabled in `eas.json`, so EAS manages build numbers remotely

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
