---
name: agent-device
description: Local mobile UI automation with the agent-device CLI. Use when testing the Bondfires Expo app on iOS simulators or Android emulators from a developer machine, or when the user mentions agent-device, simulator automation, or emulator UI testing.
disable-model-invocation: true
---

# Mobile Automation with agent-device CLI

Use `agent-device` for local mobile QA on machines that have Xcode and/or Android Studio plus a simulator or emulator. This is the native-mobile counterpart to in-browser automation (for example the IDE browser MCP).

*Local only:* use this for developer laptops or CI hosts that can run simulators/emulators. Do not assume it works from cloud-hosted agents without device farm integration, and do not assume third-party device-cloud support unless configured.

**Sources:**

- [agent-device docs](https://agent-device.dev/)
- [agent-device GitHub](https://github.com/callstackincubator/agent-device)
- Repository root `AGENTS.md` for stack and dev commands

## Preconditions

- **iOS simulators:** macOS + Xcode + iOS Simulator
- **Android emulators:** Android Studio + emulator + `adb`
- **Bondfires running locally:** Convex dev server plus Metro/Expo dev build (see “Bondfires local app setup” below)
- **CLI installed:**

```bash
npm install -g agent-device
# or use npx for one-off runs
npx agent-device --help
```

- **Verify available targets:**

```bash
agent-device devices
```

## Bondfires local app setup

Bondfires is **Expo (React Native)** with **Convex** as the backend. There is no separate Capacitor “web shell” — Metro bundles JavaScript into the dev client; Convex must be running for backend-backed flows.

**Recommended (repo root):** one command starts Convex and the native app in tmux:

```bash
yarn dev:ios
# or
yarn dev:android
```

**Manual two-terminal setup** (equivalent to what the scripts automate):

```bash
# Terminal 1 — from repo root
yarn dlx convex dev

# Terminal 2 — native run
cd apps/mobile && yarn ios
# or
cd apps/mobile && yarn android
```

If the app is already installed and you only need to reconnect or relaunch it, keep Convex (and Metro if applicable) running and use `agent-device open ... --relaunch`.

**App identifiers (for `open` / debugging):**

- iOS display name: **Bondfires** (see `apps/mobile/app.json` → `expo.name`)
- iOS bundle identifier: `org.bondfires`
- Android application ID: `org.bondfires`

## Core workflow

1. Start or select a simulator/emulator.
2. Open or relaunch the app with a named `--session`.
3. Capture a compact interactive snapshot: `agent-device snapshot -i -c`.
4. Interact with refs from that snapshot (`@e1`, `@e2`, ...).
5. After every meaningful UI change, run `agent-device diff snapshot -i -c` or re-run `snapshot -i -c`.
6. Capture screenshots or recordings for evidence.
7. Close the session when done.

## iOS Simulator flow

Use this when testing on a local iPhone simulator.

```bash
agent-device ensure-simulator --platform ios --device "iPhone 16" --boot
agent-device open Bondfires --platform ios --device "iPhone 16" --session bondfires-ios --relaunch
agent-device snapshot -i -c --session bondfires-ios
agent-device press @e3 --session bondfires-ios
agent-device fill @e7 "test@example.com" --session bondfires-ios
agent-device wait @e9 5000 --session bondfires-ios
agent-device diff snapshot -i -c --session bondfires-ios
agent-device screenshot /tmp/bondfires-ios.png --session bondfires-ios
agent-device close --session bondfires-ios
```

### Notes

- Prefer simulators over physical devices for local QA unless the task explicitly requires real-device behavior.
- If a physical iPhone is also connected, always pin the simulator with `--device` or `--udid`.
- If `open Bondfires` does not find the app, start it via `yarn dev:ios` or `cd apps/mobile && yarn ios` first, then check the foreground app with `agent-device appstate --platform ios`.

## Android emulator flow

Use this when testing on a local Android emulator.

```bash
agent-device devices --platform android
agent-device open org.bondfires --platform android --serial emulator-5554 --session bondfires-android --relaunch
agent-device snapshot -i -c --session bondfires-android
agent-device press @e4 --session bondfires-android
agent-device fill @e6 "test search" --session bondfires-android
agent-device scroll down 600 --session bondfires-android
agent-device screenshot /tmp/bondfires-android.png --session bondfires-android
agent-device close --session bondfires-android
```

### Notes

- Start the emulator from Android Studio first, or from your normal local Android workflow.
- Always pin the target emulator with `--serial` if more than one Android device is connected.
- If the package name changes or you are unsure what is installed, use `agent-device apps --platform android`.
- For fresh installs, use `agent-device install` or `agent-device reinstall`, then `open` by package name.

## Useful commands

### Discovery and state

```bash
agent-device devices
agent-device apps --platform ios
agent-device apps --platform android
agent-device appstate --session bondfires-ios
agent-device snapshot -i -c --session bondfires-ios
agent-device get text @e1 --session bondfires-ios
```

### Interaction

```bash
agent-device press @e3 --session bondfires-ios
agent-device click @e3 --session bondfires-ios
agent-device fill @e5 "hello" --session bondfires-ios
agent-device type "hello" --session bondfires-ios
agent-device scroll down 500 --session bondfires-ios
agent-device scrollintoview @e12 --session bondfires-ios
agent-device back --session bondfires-android
agent-device home --session bondfires-android
```

### Evidence and debugging

```bash
agent-device screenshot /tmp/current-screen.png --session bondfires-ios
agent-device record start /tmp/repro.mp4 --session bondfires-ios
agent-device record stop --session bondfires-ios
agent-device logs path --session bondfires-ios
agent-device network dump 50 --session bondfires-ios
```

## Working style

- **Use refs for exploration.** Take a new snapshot, then interact with the returned `@eN` refs.
- **Re-snapshot after every UI change.** Refs can go stale after navigation, modals, or list updates.
- **Prefer named sessions.** This keeps multiple runs isolated and makes cleanup easier.
- **Pin the device explicitly.** Use `--device`, `--udid`, or `--serial` in mixed environments.
- **Use screenshots/recordings for bug reports.** Capture evidence while reproducing the issue.
- **Keep the app workflow realistic.** Treat `yarn dev:ios` / `yarn dev:android` (or Convex + `cd apps/mobile && yarn ios` / `yarn android`) as the primary way to run the app under test.

## Troubleshooting

- **No device found:** open the simulator/emulator first, then run `agent-device devices`.
- **Wrong target selected:** pass `--device`, `--udid`, or `--serial` explicitly.
- **App does not launch:** start it from the repo (`yarn dev:ios`, `yarn dev:android`, or `apps/mobile` `yarn ios` / `yarn android`) with Convex running, then retry `open ... --relaunch`.
- **Stale refs or unexpected misses:** run `agent-device snapshot -i -c` again before acting.
- **Need a replayable session artifact:** use `agent-device open ... --save-script` and `agent-device replay <path>`.

## When to use

- **Use `agent-device`** for local simulator/emulator automation of Bondfires mobile UI flows.
- **Use in-browser / web automation tools** for the marketing site ([bondfires-website](https://github.com/deggertsen/bondfires-website)) or other web targets — not this skill.
- **Do not rely on this skill** for remote device farms unless that integration is explicitly available in your environment.

## Physical iPhone playbook (hard-won, June 2026)

Testing the **live recording / camera** path REQUIRES a physical device: the native
live publisher reports `isAvailable() === false` on the simulator (no camera), so the
whole RTMP record/swap/stop flow is disabled there. The simulator can only exercise
non-camera UI. The steps below are the end-to-end path that actually worked; expect
each gate to bite if skipped.

### 0. Compile-verify native code WITHOUT a device or signing (do this first)

This is the fastest way to catch Swift/Kotlin build breaks (it caught a real
actor-isolation bug in `getStats()`):

```bash
# Swift — compiles for real device arch (arm64), no signing/provisioning needed
cd apps/mobile/ios
xcodebuild -workspace Bondfires.xcworkspace -scheme Bondfires -configuration Debug \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
# Kotlin
cd apps/mobile/android
./gradlew :app:compileDebugKotlin :bondfire-live-publisher:compileDebugKotlin
```

The full xcodebuild log is huge; grep it for `: error:` and `BUILD SUCCEEDED|FAILED`.
Expo truncates its own error output, so prefer running `xcodebuild` directly and
teeing to a file.

### 1. Signing (the #1 blocker)

- App id **`org.bondfires`** is owned by team **`A9BJ2VA78M`** (the EAS/App Store team).
- Local Expo/Xcode auto-selects the WRONG team (whatever cert is in the keychain, e.g.
  `J8UCZDVZ8K` Latitude Inc) → fails with *"app identifier cannot be registered to your
  development team."* Always pass the team explicitly.
- Requires Xcode signed in to **`deggertsen@gmail.com`** with dev access to `A9BJ2VA78M`.
  If you see *"Unable to log in with account … login details were rejected,"* the human
  must re-auth Xcode (Settings → Accounts) — you cannot do the Apple ID 2FA.

```bash
cd apps/mobile/ios
xcodebuild -workspace Bondfires.xcworkspace -scheme Bondfires -configuration Debug \
  -destination 'id=<DEVICE_UDID>' \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM=A9BJ2VA78M build
```

### 2. Install + launch + trust

```bash
APP=~/Library/Developer/Xcode/DerivedData/Bondfires-*/Build/Products/Debug-iphoneos/Bondfires.app
xcrun devicectl device install app --device <UDID> "$APP"
xcrun devicectl device process launch --device <UDID> --terminate-existing org.bondfires
```

After a freshly-minted dev cert you MUST **trust it on the device** (Settings → General →
VPN & Device Management → Trust) and keep the phone **unlocked**, or automation hangs.

### 3. agent-device on a physical iPhone signs its own XCTest runner

The UI driver builds/installs an `AgentDeviceRunner` XCTest app that defaults to
callstack's team (`2S799L9W4M`) and `com.callstack.*` bundle ids — both unusable here.
Override via env, and set them **before the first `agent-device open`** (the daemon
caches its environment):

```bash
export AGENT_DEVICE_IOS_TEAM_ID=A9BJ2VA78M
export AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=org.bondfires.adrunner
export AGENT_DEVICE_IOS_RUNNER_CONTAINER_BUNDLE_ID=org.bondfires.adrunner
export AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=org.bondfires.adrunner.uitests
```

If you set them late, kill the daemon so it re-reads env, then re-open:
`pkill -f "agent-device/dist"` and `rm -rf ~/.agent-device/ios-runner/derived`.
The first runner build is slow and the default 90s request window times out — pass
`--timeout 240000` to the first `snapshot`. Symptom of the trust/lock issue: repeated
`xcodebuild test-without-building … ** BUILD INTERRUPTED **` in
`~/.agent-device/sessions/<session>/runner.log`.

### 4. Loading JS: prefer a self-contained RELEASE build over Metro

**For validating a native/config fix, skip Metro entirely.** Build in Release
config — `xcodebuild ... -configuration Release` bundles the JS into the binary
(`main.jsbundle`), so the installed app just runs: no Metro, no dev launcher, no
tunnel, no URL to type. This is the most reliable loop and avoids every gotcha
below. Install with `devicectl ... install app` then `... process launch`, and
read results from prod Convex telemetry (`clientLogs:_debugTriage`). Recording
in a personal camp is safe; just reaching the record screen fires
`live:availability` / `live:camera_list`, which is enough to confirm a native
registration fix without creating prod data.

Only use a Debug build + Metro when you actually need hot reload / JS iteration.
In that case the phone often can't reach the Mac's Metro over LAN (different
subnet / Wi-Fi AP isolation) — try the LAN URL `exp://<mac-lan-ip>:8081` first
(get the IP via `ipconfig getifaddr en0`), and fall back to a tunnel only if LAN
fails:

```bash
npm install -g @expo/ngrok@^4.1.0      # one-time
cd apps/mobile && npx expo start --dev-client --tunnel
```

Getting the tunnel URL: the ngrok `4040` inspector API is often NOT exposed, and
a backgrounded `expo start` won't print the QR banner. Pull the host from the
dev server manifest instead:

```bash
curl -s -H "expo-platform: ios" http://127.0.0.1:8081/ | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).extra?.expoClient?.hostUri||JSON.parse(s).hostUri))'
```

The deep link `bondfires://expo-development-client/?url=<encoded>` does NOT reliably
auto-load; instead drive the dev launcher UI: tap **Enter URL manually**, fill the
URL, tap **Connect**, then **Allow** the iOS "find devices on local networks"
prompt. The launcher's RN buttons aren't in the a11y tree — use coordinate taps.

### 5. Driving the RN app (a11y tree is sparse)

- The interactive snapshot (`-i -c`) frequently returns only the app root (1 node) for
  the RN app. Use **screenshots as truth**, `snapshot --raw -d 80` to read element
  `rect`s, and **coordinate taps** (`press <x> <y>`). Device coordinate space here is
  **375×667 points**; the 5-tab bar centers at x = 37/112/187/262/337, y ≈ 642.
- First record triggers **Camera** then **Microphone** permission dialogs (Allow).
- **Recording flow:** Spark tab → "Choose a Camp" (dismiss keyboard via `done`) → pick a
  camp → record screen. Use **"David Eggertsen's Fire" (personal, no-audience camp)** for
  throwaway test data — it stays out of the public Discover feed.
- A Metro warning that `BondfireLivePublisher`'s view manager "isn't exported"
  is **NOT cosmetic** — it means the native module failed to register with Expo
  (see "iOS autolinking gotcha" below). When that happens, `isAvailable()`
  returns `false`, the live preview falls back to a blank `View`, and the app
  silently routes recording to the legacy upload queue. If you see this warning,
  fix the registration before trusting anything else on the live path.
- **Duration cap is 180 min** — not exercisable live; lower it in a debug build to test
  the cap-finalization path.
- Known quirk: the **`+`** button in a personal-camp detail view re-presents stale
  "…being processed" success modals; use the **Spark tab** for a clean recording entry.

### 5b. Network-kill testing on a physical iPhone (gotcha)

agent-device's control channel to a physical iPhone is **wireless**, not USB. So
toggling **airplane mode** to simulate a network drop ALSO severs your automation
control — you go blind until Wi-Fi returns, and only the human at the device can
toggle it back. Plan for that: kick off the recording, ask the owner to toggle
airplane mode (and to report what the screen shows during the blind window), then
ask them to toggle it back so the runner reconnects (runner re-attach took ~60s).

What the recording fix actually does on connection death (verified June 2026): the
connection monitor emits `endpoint_closed`/`stream_stopped_unexpectedly`, and
`LiveRecordScreen.stopLiveRecording()` fires. The **freeze is fixed** — the UI leaves
the red "● REC" screen and returns to idle. BUT `stopLiveRecording()` calls
`livePublisher.stop()` → Mux `/complete`, which **throws while still offline**; the
catch path shows a "Stopping… may still finish processing" alert and resets to idle.
If the device is still offline at finalize AND you then navigate away (unmount runs
`cancelLiveRecording`), the partial session is cancelled and **no bondfire is saved**.
So "auto-save the partial" only holds when connectivity returns by finalize time. To
verify save-vs-loss, query prod Convex (read-only): `videos:listStuckMuxRecords`,
`videos:listStaleMuxLiveSessions`, and `convex data liveSessions/bondfires --order desc`.

### 6. Backend reality

`apps/mobile/.env` bakes **prod** Convex (`EXPO_PUBLIC_CONVEX_URL=…ideal-akita-27…`) and
the repo's root `.env.local` sets `CONVEX_DEPLOYMENT=prod` — there is no dev deployment.
So `convex dev` deploys to prod, and on-device recording creates **real prod data
+ Mux live streams**. Confirm with the owner before recording, and prefer the personal
camp for cleanup.

### 7. iOS autolinking gotcha (the bug that disabled live for ALL iOS users, June 2026)

For a long stretch, iOS live recording **never worked** — every iOS user was
silently routed to the dead legacy upload queue. The native `BondfireLivePublisher`
module was compiled into the binary (the CocoaPods pod linked fine) but **never
registered with Expo's module runtime**, so `requireNativeModule('BondfireLivePublisher')`
threw and `index.ts` fell back to `isAvailable()=false` / `getCameraCount()=0`.
Telemetry tell: `live:availability` was `available:false` and `live:camera_list`
`cameraCount:0` on EVERY iOS device, forever, while Android worked.

Root cause was in `apps/mobile/modules/bondfire-live-publisher/expo-module.config.json`,
and `expo-modules-autolinking@3.x` exposed two traps, both invisible on Android:

1. **Platform key:** autolinking reads the **`apple`** key, not legacy **`ios`**.
   A config with `"platforms": ["ios", ...]` / `"ios": { "modules": [...] }` is
   silently ignored on Apple. Use `"apple"`.
2. **Podspec location:** Apple resolution (`resolveModuleAsync` → `findPodspecFiles`
   → `listFilesInDirectories`) only finds `.podspec` files inside **top-level
   subdirectories** (e.g. `ios/`). A podspec at the module **root** is dropped, and
   the whole module silently disappears from resolution. Either move the podspec
   into `ios/`, or point at it with `"apple": { "podspecPath": "Foo.podspec" }`.

How to diagnose fast (no device, no build) — compare what autolinking resolves:

```bash
cd apps/mobile
npx expo-modules-autolinking resolve -p apple --json  | grep -o '"packageName":"[^"]*"'
npx expo-modules-autolinking resolve -p android --json | grep -o '"packageName":"[^"]*"'
# If a local module shows up for android but not apple, it's this bug.
```

Ground truth: after `pod install`, the module must appear in
`ios/Pods/Target Support Files/Pods-Bondfires/ExpoModulesProvider.swift`
(both the `import` and `getModuleClasses()` lists, debug AND release). If it's
absent there, it will not register at runtime no matter how good the Swift is.

**Corollary — fixes in dead code:** because `start()` never ran on iOS until the
registration was fixed, two native bugs sat latent behind it. Editing Swift that
never executes proves nothing; verify the module is registered FIRST, then debug
the live path. The two it hid:

- **HaishinKit 2.x needs factory registration.** Call
  `await SessionBuilderFactory.shared.register(RTMPSessionFactory())` before
  `make(url).build()`, or `build()` throws `.notFound`
  ("SessionBuilderFactory.Error error 1").
- **Encoder orientation.** `camera.activeFormat.dimensions` is the sensor's
  LANDSCAPE size; the mixer emits PORTRAIT frames. Setting `videoSize` to the
  landscape dims makes HaishinKit's default `.trim` scaling center-crop the
  portrait frame → "super zoomed in" recording with a correct preview. Encode
  short-side × long-side (portrait).

This is CNG/managed: `apps/mobile/ios` is gitignored and regenerated by `expo
prebuild` during `eas build --local` (see `scripts/release.sh`), so the fix lives
entirely in the committed `expo-module.config.json` + module Swift — no native
state in git to go stale.
