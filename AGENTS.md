# AGENTS.md — Bondfires

## What This Is
Video sharing social app — users create "bondfires" (video posts), others respond with video to build connections.

## Tech Stack
React Native (Expo) + Tamagui + Legend State + Convex (backend/DB/auth/file storage) + Mux Video + Turborepo monorepo + Yarn.

## Structure
```
apps/mobile/                    — Expo mobile app
apps/website/                   — Marketing / landing site (static HTML)
convex/                         — Convex backend, auth, and HTTP actions
infrastructure/terraform/       — AWS/Terraform infrastructure
packages/ui/                    — Shared Tamagui components
packages/app/                   — Features, hooks, Legend State stores
packages/config/                — Tamagui configuration
packages/video-segment-merger/  — Native video processing package (iOS/Android)
```

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

## Branch Rules
- Never push directly to main
- Branch naming: `agent/<type>/<description>`
- All changes via PR

## Owner
Managed by David + Jacob (Jake). Celeste + Forge supervise agent work.
