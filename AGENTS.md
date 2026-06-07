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

## Branch Rules

- Branch naming: `agent/<type>/<description>`
- Always commit and push changes to avoid changes being lost

## Owner

Managed by David + Jacob (Jake). Celeste + Forge supervise agent work.
