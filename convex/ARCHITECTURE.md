# Convex Architecture Notes

Notes for future contributors (human or agent) working on the backend. Project-wide development guidelines live in `.claude/CLAUDE.md`; this file covers backend-specific architectural intent.

## Forward-Looking: Third-Party Embed / Public API

We don't have a public API or third-party embed feature today, but it is on the roadmap. The current Convex + Mux stack supports it cleanly without major refactoring, and the goal of this note is to keep it that way as we build other things.

**When introducing new scoping primitives or visibility settings** — orgs, channels, collections, creator-level settings, sharing controls, anything that defines "who can see / reference this" — design with "could a third party reference or embed this from outside the app?" in mind. Cheap to bake in now, painful to retrofit.

Concretely:

- **Don't leak Convex doc IDs as public-facing identifiers.** Any entity that could plausibly be referenced from outside the app (bondfires being the obvious one, but also future orgs/channels/collections) should grow a stable, public-safe ID or slug field alongside its `_id`. Convex IDs are fine internally; they're not fine in URLs, embed codes, or third-party integrations.

- **Put embed/visibility flags on the scope object itself.** A future creator-level "allow embedding" toggle, a per-bondfire "embeddable" flag, or a per-API-key `allowedOrigins` list all belong next to the rest of that entity's settings — not in a side table. Group them with the data they govern.

- **Keep `muxPlaybackPolicy` an explicit per-video decision.** It's already modeled correctly (`'public' | 'signed'` on both `bondfires` and `bondfireVideos` in `schema.ts`). When adding new video-creation flows, surface this choice rather than hardcoding one or the other. Public is trivial to embed; signed requires a JWT-minting action — both paths should remain open.

- **Make watch / analytics attribution able to handle anonymous sources.** The current `watchEvents` table requires `userId: v.id('users')`. Embedded plays from third-party sites won't have a Convex auth user — they'll be attributed to an API key, an origin, or simply anonymous. Any future migration of `watchEvents` (or new analytics tables) should preserve the ability to record plays without a userId.

- **Public HTTP routes live in `convex/http.ts`.** The existing Mux webhook handler there is the pattern to follow: signature/auth verification in the route, internal mutations for writes. Future REST endpoints (`GET /v1/bondfires/:publicId`, oEmbed, etc.) should slot in alongside it rather than spawning a separate service.

This is guidance for *new* changes — there is no action item to retrofit existing code. The aim is just to avoid foreclosing the embed/API path while we build other features.
