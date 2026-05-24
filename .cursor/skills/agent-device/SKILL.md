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
