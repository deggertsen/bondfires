# AGENTS.md — Bondfires

## What This Is

Video sharing social app — users create "bondfires" (video posts), others respond with video to build connections.

## Tech Stack

React Native (Expo) + Tamagui + Legend State + Convex (backend/DB/auth/file storage) + Mux Video + Turborepo monorepo + Yarn.

## Structure

```
apps/mobile/                    — Expo mobile app
convex/                         — Convex backend, auth, and HTTP actions
infrastructure/terraform/       — Legacy AWS website infra (deprecated)
packages/ui/                    — Shared Tamagui components
packages/app/                   — Features, hooks, Legend State stores
packages/config/                — Tamagui configuration
packages/video-segment-merger/  — Native video processing package (iOS/Android)
scripts/                        — Release, provisioning, dev helpers
```

Marketing website: separate repo at https://github.com/deggertsen/bondfires-website (Cloudflare Pages).

## How to Run

```bash
yarn install
yarn dev              # Start dev server
yarn dev:ios          # iOS simulator
yarn dev:android      # Android
```

## Validation (run before every commit)

```bash
yarn typecheck        # TypeScript checks
yarn lint             # Linting
yarn format           # Code formatting
yarn check            # Biome check
```

## Patterns

- Convex for all backend logic (mutations, queries, actions)
- Mux for bondfire video upload/playback
- Tamagui for UI components (shared via packages/ui/)
- Legend State for client state management
- Expo Router for navigation

## Theming Rules

Bondfires supports light and dark themes. UI work must preserve theme correctness.

- Prefer Tamagui theme tokens for Tamagui components: `$background`, `$backgroundHover`, `$backgroundPress`, `$color`, `$placeholderColor`, `$primary`, `$secondary`, `$borderColor`, `$success`, `$error`, and `$warning`.
- Do not add new hardcoded color literals in app or shared UI components unless the color is intentionally fixed, such as video overlays, translucent scrims, gradients, or external brand colors.
- Do not pass Tamagui token strings to React Native native props that require resolved color strings. This includes `StatusBar.backgroundColor`, `RefreshControl.tintColor`, `RefreshControl.colors`, `TextInput.placeholderTextColor`, and inline `StyleSheet` color values.
- For native color props, use `useAppThemeColors()` for authenticated/main app surfaces and `useSystemThemeColors()` for signed-out/auth surfaces. These hooks live in `packages/app/src/hooks/useThemeColors.ts`.
- Keep shared Tamagui component styling in `packages/ui/` token-based. If a shared component needs a native color string, resolve it through the theme color helpers instead of duplicating hex values.
- Before committing theme or UI changes, search for regressions:

```bash
rg -n "bondfireColors|#[0-9A-Fa-f]{6}|placeholderTextColor=\\{'\\$|tintColor=\\{'\\$|colors=\\{\\['\\$" apps/mobile packages/ui packages/app
```

Hardcoded colors or `bondfireColors` references are not automatically wrong, but they need a clear reason. Token strings in the native props above should be fixed.

## Branch Rules

- Branch naming: `agent/<type>/<description>`
- Always commit and push changes to avoid changes being lost

## Owner

Managed by David + Jacob (Jake). Celeste + Forge supervise agent work.
