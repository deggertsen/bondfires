# Dependency modernization — August 2026

This pass refreshes the current production stack without crossing framework boundaries that require a separate native migration. The lockfile was fully re-resolved within every declared range with Yarn 4.12.0. No audit fix was forced, and there are no dependency resolutions overriding an upstream package range.

## Upgraded production stack

| Area | Before | After | Notes |
| --- | --- | --- | --- |
| Expo SDK | `expo` 54.0.35 | 54.0.37 | SDK 54 patch alignment; `expo-constants` 18.0.14 and `expo-file-system` 19.0.24 |
| Convex | 1.41.x | 1.45.x | Backend and mobile client remain aligned |
| Convex Auth | 0.0.90 / `@auth/core` 0.37.4 | 0.0.95 / 0.41.3 | Satisfies Convex Auth's `@auth/core ^0.41.1` peer and removes the direct Auth advisories |
| Legend State | manifest beta.27, lock beta.43 | beta.48 (exact) | Retains the existing v3 beta architecture while avoiding an unreviewed channel change |
| Tamagui | 1.144.0–1.144.1 | 1.144.4 | Latest v1 release across app, config, UI, Babel, and Metro packages |
| MMKV / Nitro | 4.1.1 / 0.32.1 | 4.3.2 / 0.37.1 | Kept as a compatible pair |
| Video metadata | `react-native-compressor` 1.16.x | 1.19.2 | Latest v1; v2 is a separate Node/native migration |
| Purchases | `expo-iap` 4.3.x | 4.7.2 | Latest release allowed by the existing v4 range |
| Web | `react-native-web` 0.21.0 | 0.21.2 | SDK 54's React Native Web generation |
| Tooling | Biome 2.4.6, Turbo 2.3.x, Vitest 4.1.9 | Biome 2.5.11, Turbo 2.10.12, Vitest 4.1.11 | Biome config migrated to the 2.5 schema |
| Node types | 25.x | 22.20.1 | Intentionally aligned to CI's supported Node 22 runtime |

`expo-av` was removed because the application no longer imports it. Recording and playback use `expo-camera` and `expo-video`; the camera plugin already declares the microphone permission previously duplicated by the `expo-av` plugin.

The mobile workspace now declares `@auth/core`, `@babel/core`, and `react-refresh` directly to satisfy the peer contracts of Convex Auth and the Expo Babel/Reanimated toolchain.

## Security audit

`yarn npm audit --all --recursive` reports advisory records, so one vulnerable package can produce several records.

| Severity | Before | After |
| --- | ---: | ---: |
| Critical | 3 | 0 |
| High | 63 | 9 |
| Moderate | 33 | 12 |
| Low | 4 | 0 |
| Total | 103 | 21 |

The remaining findings are transitive dependencies constrained by the current supported framework packages:

| Path | Remaining severity | Why it remains |
| --- | --- | --- |
| `@convex-dev/auth@0.0.95 -> @oslojs/crypto@1.0.1 -> @oslojs/{asn1,binary}` and `@convex-dev/auth -> lucia@3.2.2` | Moderate | Convex Auth's current stable dependency graph; replacing or overriding these authentication internals would be unsupported |
| `expo@54.0.37 -> @ungap/structured-clone@1.3.0` | Moderate | Pinned by the supported Expo SDK 54 graph |
| `@expo/plist@0.0.18/0.4.9 -> @xmldom/xmldom@0.7.13/0.8.11` | High (5 records) | Fix requires crossing `0.x` minor ranges used by Expo tooling |
| `@expo/metro-config@54.0.17 -> postcss@8.4.49` | High/moderate (4 records) | Patched PostCSS is outside Expo Metro's declared `~8.4.32` range |
| `metro@0.83.3 -> image-size@1.2.1` | High (2 records) | No patched `image-size` release currently exists; latest 2.0.2 is also reported vulnerable |
| `react-native@0.81.5 -> glob@7.2.3 -> inflight@1.0.6` | Moderate | React Native toolchain constraint; major override is not production-safe |
| `query-string@7.1.3 -> decode-uri-component@0.2.2` | Moderate | Transitive tooling range |
| `chromium-edge-launcher@0.2.0 -> rimraf@3.0.2` | Moderate | Development tooling only |
| `@bacons/xcode@1.0.0-alpha.32` / `xcode@3.0.1 -> uuid@7/8` | Moderate | Apple target generation tooling |

These findings do not justify unsupported lockfile overrides. Re-run the audit during each Expo/React Native upgrade and when Convex Auth publishes a new stable dependency graph.

## Deliberately deferred framework migrations

- **Expo 55, 56, and 57 / React Native 0.82–0.87:** Expo recommends upgrading one SDK at a time. SDK 55 and later require the New Architecture, while Bondfires includes the custom `bondfire-live-publisher` native module and a patched `expo-video`. Each SDK step needs clean iOS and Android builds, native live-stream testing, and patch rebasing. See the [Expo upgrade walkthrough](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/), [SDK 54 reference](https://docs.expo.dev/versions/v54.0.0/), and [New Architecture guide](https://docs.expo.dev/guides/new-architecture/).
- **Tamagui 2:** This is a source and visual migration, not a lockfile update. Its migration guide includes component/prop changes and requires full light/dark visual regression coverage. See [Tamagui's v2 upgrade guide](https://tamagui.dev/docs/guides/how-to-upgrade).
- **React 19.2 and Expo-managed native module minors:** SDK 54 expects React 19.1, React Native 0.81, React Navigation 7.1, and Keyboard Controller 1.18. Expo Doctor rejects the newer combinations.
- **TypeScript 7, Babel 8, `@types/node` 26, `react-native-compressor` 2, `expo-iap` 5, and Apple Targets 5:** These are major migrations. Node types remain on 22.x to match CI rather than permitting unavailable runtime APIs.

## Validation and release smoke test

Automated validation completed for this dependency set:

- `yarn install --immutable`
- `yarn format`
- `yarn validate` (38 files, 246 tests)
- Expo Doctor (18/18 checks)
- Expo config introspection
- clean temporary `expo prebuild --no-install --platform all` for iOS and Android
- `yarn npm audit --all --recursive`

Before releasing a build, complete this device checklist on clean EAS development builds for both iOS and Android:

- sign up, sign in, email verification, password reset, and sign out;
- record with camera/microphone, compress/upload, play, background, and resume video;
- start/end a Mux live session and verify the custom publisher lifecycle;
- force-close/relaunch and confirm MMKV-backed session and upload state;
- receive and open camp, bondfire, and account notification deep links;
- run sandbox subscription purchase, restore, cancellation-state refresh, and receipt acknowledgment;
- verify light/dark themes and one web export smoke pass.
