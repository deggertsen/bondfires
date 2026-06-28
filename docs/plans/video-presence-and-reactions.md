# Video Presence & Reactions

**Author(s):** David (mavrick2424) + Forge
**Date:** 2026-06-27
**Status:** Draft
**Complexity:** Large

---

# ONE-PAGER

## Diagnosis

Bondfires videos are a passive viewing experience — you watch, maybe respond, but there's no signal that others are there with you or that anyone engaged with a moment. Two overlapping features solve this: real-time presence (see who's watching right now) and timestamped emoji reactions (see who reacted and when). These share the same UI real estate and mental model: the left side of the video player is a "people" zone showing avatars.

## Current Gaps

- No real-time presence system — `watchEvents` records one-shot analytics but doesn't track who's actively viewing
- No lightweight engagement mechanism during video playback
- Report button is the only interactive control on the right side, rarely used
- No social signal that others watched or reacted to a video

## Solution Summary

Add a unified viewer stack on the left side of the video player (below the back button). It renders two layers: (1) **Live viewers** — persistent avatars of people currently watching the same video, with "watching" labels, updated in real time via Convex reactive queries. (2) **Reactions** — transient avatars that pop in at their recorded timestamp with an emoji growing from the avatar, then fade after ~1.5s. If a live viewer reacts, only the emoji animates over their existing persistent avatar (no duplicate). An emoji button on the right side (replacing Report's current position; Report moves to left side above creator info) opens a floating 4x4 grid with a recent-emojis side column. Free users get 3 emojis (pray, heart, fire); the rest are grayed with a lock icon and upgrade prompt. Reactions are VOD-only for v1; presence works on all video playback.

## Not Doing (Out of Scope)

- Live stream emoji reactions (VOD only for v1; schema designed to support live later)
- Feed-level reaction indicators (counts, emoji bubbles on thumbnails)
- Server-side throttle enforcement (client-side only)
- Custom emoji assets (using native Unicode emojis)
- Reaction deletion or editing by users
- Notification on reaction received
- Feed-level presence (`feed.tsx` does not participate)
- Presence on the legacy recording path (`LegacyRecordScreen.tsx`)
- Presence notifications or push alerts
- "Who's online" global indicator
- Phase 2 consideration: Real-time reaction delivery for live streams
- Phase 2 consideration: Reaction summary on feed thumbnails
- Phase 2 consideration: Presence on the feed swipe view

---

# VERIFICATION CONTRACT

## Success Criteria

### Must Have

#### Presence — Heartbeat & Data

- [ ] **Presence heartbeat fires every 30s while viewing a video in the thread view**
  - *Verify by:* Open `bondfire/[id].tsx`, check Convex dashboard for heartbeat mutations every ~30s with correct `videoType` + `videoId` + `userId`.
- [ ] **Heartbeat stops when the user leaves the screen, backgrounds the app, or the video goes inactive**
  - *Verify by:* Navigate away or background the app → no further heartbeat mutations. A `leaveViewing` mutation is called on unmount/blur.
- [ ] **Presence is scoped to the specific video, not the bondfire thread**
  - *Verify by:* User A watches the spark video, User B watches response #2 → User A only sees User B if they're both viewing the same video. Switching videos changes the presence list.
- [ ] **Stale presence entries are cleaned up by a scheduled cron**
  - *Verify by:* Close the app (no `leaveViewing` call) → after ~65s the viewer's presence row is pruned by the cleanup job and disappears from all clients.

#### Presence — UI

- [ ] **Avatar stack renders on the playback screen below the back button, left side**
  - *Verify by:* Open a bondfire thread with 2+ concurrent viewers → see avatars stacked vertically in the top-left, below the "Campground" back button pill. Each avatar shows the viewer's profile photo with "watching" text below it.
- [ ] **Avatar stack renders on the recording screen below the X button**
  - *Verify by:* Start recording a live bondfire with a viewer watching → recorder sees the viewer's avatar in the top-left below the X/close button.
- [ ] **Current user is excluded from the live viewer list**
  - *Verify by:* Open your own bondfire thread → you do not see your own avatar in the viewer stack.
- [ ] **Empty state is invisible — no UI shown when no viewers are present**
  - *Verify by:* Open a bondfire with no other viewers → the avatar stack area renders nothing, no empty-state placeholder.
- [ ] **Stack caps at 5 avatars visible and becomes scrollable beyond that**
  - *Verify by:* Simulate 6+ concurrent viewers → only 5 avatars are visible, the stack scrolls vertically to reveal the rest.

#### Reactions — Emoji Button & Grid

- [ ] **Emoji button replaces Report button position on right side controls**
  - *Verify by:* Open video player, emoji button visible on right side where Report was. Report button is now on left side above creator info (`bottom: ~200, left: 20`).
- [ ] **Tapping emoji button opens a floating 4x4 grid with slightly transparent background**
  - *Verify by:* Tap emoji button while watching a VOD. Grid appears near button location. Video is still visible through the transparent background. Grid does not dim or modal-block the video.
- [ ] **Grid shows a right-side single column for frequently-used emojis (4 slots)**
  - *Verify by:* When grid is open, a separate column is visible on the right side of the main 4x4 grid showing 4 recently-used emojis.
- [ ] **Grid auto-closes after selecting an emoji**
  - *Verify by:* Tap an available emoji → grid closes immediately. Emoji button is tappable again to reopen.
- [ ] **Free users see 3 emojis (pray, heart, fire) fully colored; all others grayed with lock icon**
  - *Verify by:* Log in as free-tier user, open emoji grid. Pray, heart, fire are colored and tappable. All other emojis are grayed with a lock overlay. Tapping a locked emoji shows an upgrade prompt.
- [ ] **Free users' 3 emojis always appear in the recent column without tracking**
  - *Verify by:* As a free user, the recent column always shows pray, heart, fire regardless of usage.
- [ ] **Paid users see full emoji set, all tappable, with recent emojis tracked per-user**
  - *Verify by:* As a paid user, all emojis are colored and tappable. Tap several emojis. Reopen grid — recently tapped emojis appear in the right column sorted by frequency (4 slots).
- [ ] **Emoji button not shown during live streams**
  - *Verify by:* Open a live stream. Emoji button is not visible on the right side controls.

#### Reactions — Animation & Persistence

- [ ] **Tapping an available emoji saves a reaction at the current video timestamp**
  - *Verify by:* Note current video time. Tap an emoji. Check Convex dashboard — a `videoReactions` record exists with the correct video reference, userId, emoji, timestampMs, denormalized userDisplayName + userPhotoUrl.
- [ ] **Optimistic local animation fires immediately on tap — user's own avatar pops in on the left side with the emoji growing from it, then fades**
  - *Verify by:* Tap emoji while watching. Animation starts within 1 frame (no visible delay). User's avatar image (photoUrl) appears in the viewer stack on the left side. Emoji renders growing over the avatar. Both fade away after ~1.5s. If network fails, no error toast — reaction just doesn't persist.
- [ ] **Reactions replay at their recorded timestamp for all viewers**
  - *Verify by:* User A reacts at 0:15. User B watches the same video. At 0:15, User A's avatar + emoji animate on the left side in the same viewer stack. User A rewatches — their own reaction replays at 0:15.
- [ ] **Concurrent reactions stack vertically in received order**
  - *Verify by:* Multiple users react within ~500ms of each other. During playback, all reactions at that timestamp animate simultaneously, stacked vertically in the viewer stack in creation order.
- [ ] **If a live viewer reacts, only the emoji animates over their existing persistent avatar**
  - *Verify by:* User A is watching (visible in live viewer stack). User A taps an emoji. Emoji grows from User A's existing persistent avatar — no second avatar appears. After ~1.5s the emoji fades but User A's persistent avatar remains.
- [ ] **Reaction animation uses Tamagui AnimatePresence for avatar enter/exit and RN Animated for emoji scale growth**
  - *Verify by:* Avatar fades in via Tamagui enter animation. Emoji scales from 0.5x to 1.5x via RN `Animated.timing`. Avatar + emoji fade out via Tamagui exit animation. Smooth, no jank.
- [ ] **No "watching" label on transient reaction avatars**
  - *Verify by:* When a reaction animation plays (past reaction replay), the avatar shows with emoji but no "watching" text below it. Live viewers have "watching" text; reaction-only avatars do not.

#### Reactions — Throttle & Gating

- [ ] **Client-side throttle: max 1 reaction per 5 seconds per user**
  - *Verify by:* Tap an emoji, then immediately tap another. Second tap is ignored (no animation, no save). Wait 5 seconds, tap again — works.
- [ ] **Reactions only available for VOD videos (not live)**
  - *Verify by:* Emoji button not shown during live streams. Reactions cannot be created during live playback.

#### Report Relocation

- [ ] **Report button works from new left-side position above creator info**
  - *Verify by:* Pause video. Tap Report button on left side (above creator info, below viewer stack if present). Report overlay opens as before. Submit a report — works as before.

#### Type Safety

- [ ] **TypeScript compiles clean**
  - *Verify by:* `npx tsc --noEmit` passes with zero errors
- [ ] **Convex functions typecheck**
  - *Verify by:* `npx convex dev --typecheck` passes

### Nice to Have

- [ ] **Haptic feedback on emoji tap** — light haptic on iOS, subtle vibration on Android
  - *Verify by:* Tap emoji on iOS — light haptic. On Android — subtle vibration.
- [ ] **Smooth fade-in/out animation when live viewers join/leave** — Tamagui AnimatePresence enter/exit
  - *Verify by:* A viewer joins → their avatar fades in over ~200ms. A viewer leaves → fades out.
- [ ] **Adaptive avatar spacing — avatars compress and overlap as more appear**
  - *Verify by:* 2 viewers = normal spacing. 4 viewers = tighter spacing. 6+ viewers = avatars overlap partially. Scrollable when exceeding visible area.
- [ ] **Avatar tap opens user's profile (if feasible given navigation constraints)**
  - *Verify by:* Tap a viewer's avatar → navigates to their profile or shows a tooltip with their name.

## Verification Scenarios

### Happy Path

1. **Given** David and Jake are both watching the same VOD bondfire video, **when** Jake's presence heartbeat fires, **then** David sees Jake's avatar in the top-left viewer stack with "watching" label. Jake does not see his own avatar.
2. **Given** Jake is watching a VOD, **when** he taps the emoji button and selects 🔥 at 0:12, **then** the grid auto-closes, Jake's avatar pops into the left-side viewer stack with 🔥 growing from it, the animation fades after ~1.5s, and a `videoReactions` record is saved with timestampMs = 12000.
3. **Given** David watches the same video later, **when** playback reaches 0:12, **then** Jake's avatar + 🔥 animation plays in the left-side viewer stack (no "watching" label — this is a transient reaction, not a live viewer).
4. **Given** Jake rewatches the same video, **when** playback reaches 0:12, **then** his own reaction replays (he sees his own avatar + 🔥 even though he's excluded from the live viewer list).
5. **Given** David and Jake are both watching (both in each other's live viewer stacks), **when** David taps ❤️ at 0:20, **then** ❤️ grows from David's existing persistent avatar in Jake's viewer stack — no duplicate David avatar appears. David's persistent avatar remains after the emoji fades.
6. **Given** a free user opens the emoji grid, **when** they tap a locked emoji, **then** an upgrade prompt appears and no reaction is saved.
7. **Given** a user taps an emoji, **when** they tap another within 5 seconds, **then** the second tap is ignored.

### Edge Cases

1. **Given** a video with 20+ reactions at the same timestamp, **when** playback reaches that point, **then** all reactions animate simultaneously stacked vertically. If the stack exceeds available vertical space, it scrolls. Adaptive spacing compresses avatars as count increases.
2. **Given** a user with no profile photo (photoUrl is null), **when** they react, **then** a default avatar placeholder (Flame icon in branded circle, matching the creator avatar style) is used instead.
3. **Given** the network is unavailable, **when** a user taps an emoji, **then** the optimistic animation plays locally but no reaction is persisted. No error is shown. The reaction does not replay on future viewings.
4. **Given** a user is scrubbing (dragging the progress bar), **when** playback crosses a reaction timestamp during scrub, **then** reactions at that timestamp do not animate (skip during scrub, resume when scrub ends).
5. **Given** a live stream is playing, **when** the user views the player, **then** the emoji button is not shown. Live viewer presence still works.
6. **Given** a viewer closes the app abruptly, **when** 65 seconds pass, **then** the cleanup cron prunes their stale presence and they disappear from all clients.
7. **Given** a viewer is watching response #3, **when** they swipe to response #4, **then** they leave response #3's presence and join response #4's. The presence list updates for both videos.
8. **Given** the only viewer is the video owner, **then** no avatar stack is rendered (empty state is invisible).
9. **Given** the recording screen is in the pre-connected phase (not yet live), **then** no viewer stack is shown (viewers can only exist when stream is live).

### Regression Checks

- Report button functionality unchanged (same overlay, same flow) — only position changed
- Mute button still works from right side controls
- Play/pause overlay still functions
- Progress bar scrubbing still works
- Video preloading (previous/current/next) still works
- Creator info display is unchanged at bottom-left
- Existing `watchEvents` analytics still fire correctly and independently
- Existing feed behavior unaffected — `feed.tsx` does not send heartbeats or show presence
- Recording screen performance not impacted
- `npx tsc --noEmit` passes
- `npx convex dev --typecheck` passes

## Automated Tests

- **Convex mutation test (reactions):** Create reaction → verify record exists with correct fields → verify denormalized user data
- **Convex mutation test (presence):** Heartbeat → verify presence row upserted → leaveViewing → verify row deleted
- **Convex query test (reactions):** Insert N reactions at various timestamps → query by video → verify sorted by timestampMs ascending
- **Convex query test (presence):** Insert presence rows → query listViewers → verify only non-stale rows returned
- **Validation commands:** `npx tsc --noEmit`, `npx convex dev --typecheck`

---

# IMPLEMENTATION CONTEXT

## Required Reading

- `apps/mobile/app/(main)/bondfire/[id].tsx` — VideoPlayer component (lines 118-810), right-side controls (lines 778-800), creator info (lines 762-776), progress tracking (lines 290-350), header layout (lines 1467-1530). This is the primary integration surface.
- `apps/mobile/components/ReportButton.tsx` — Current Report button component being relocated
- `apps/mobile/components/videoOverlayColors.ts` — Overlay color constants (use these for all new overlay UI)
- `apps/mobile/components/create/LiveRecordScreen.tsx` — Recording screen; header XStack at ~line 958
- `apps/mobile/components/InviteSheet.tsx` — Reference for Tamagui `Avatar.Image` + `Avatar.Fallback` usage
- `convex/schema.ts` — Schema file where `videoReactions` and `presence` tables will be added
- `convex/crons.ts` — Existing cron registration pattern
- `convex/errors.ts` — `withUserFacingActionErrors` pattern for Convex mutations
- `packages/config/src/tamagui.config.ts` — Animation presets (bouncy, lazy, quick, medium, slow, themeCrossfade)
- `packages/app/src/store/subscription.store.ts` — `tierMeetsRequirement` function, `subscriptionStore$.currentTier`, `showPaywall()`
- `packages/app/src/hooks/useSubscription.ts` — `useSubscription` hook for getting current user's tier

## Strategy & Constraints

**General approach:** Three PRs — backend first (schema + Convex functions + cron), then frontend presence (hook + heartbeat + viewer stack + recording screen), then frontend reactions (emoji button + grid + tier gating + reaction animation + playback + Report relocation). Backend PR must be reviewed and merged before frontend work begins.

### PR 1: Backend (Schema + Convex Functions + Cron)

**New tables in `convex/schema.ts`:**

```typescript
// Video Reactions — timestamped emoji reactions on VOD videos
videoReactions: defineTable({
  // Video reference — exactly one must be set (enforced in mutation)
  bondfireId: v.optional(v.id('bondfires')),
  bondfireVideoId: v.optional(v.id('bondfireVideos')),

  // Reactor info (denormalized for playback performance — no joins needed)
  userId: v.id('users'),
  userDisplayName: v.optional(v.string()),
  userPhotoUrl: v.optional(v.string()),

  // Reaction data
  emoji: v.string(),          // Unicode emoji character
  timestampMs: v.number(),     // Position in the video (ms from start)

  // Timestamps
  createdAt: v.number(),
})
  .index('by_bondfire', ['bondfireId', 'timestampMs'])
  .index('by_bondfire_video', ['bondfireVideoId', 'timestampMs'])
  .index('by_user_video', ['userId', 'bondfireId', 'createdAt'])

// Presence — real-time viewer tracking
presence: defineTable({
  videoType: v.union(v.literal('bondfire'), v.literal('response')),
  videoId: v.string(), // ID of the specific video (bondfire or bondfireVideo)
  userId: v.id('users'),
  userName: v.string(),          // denormalized for query efficiency
  userPhotoUrl: v.optional(v.string()), // denormalized
  lastHeartbeatAt: v.number(),
  createdAt: v.number(),
})
  .index('by_video', ['videoType', 'videoId'])
  .index('by_video_user', ['videoType', 'videoId', 'userId'])
  .index('by_heartbeat', ['lastHeartbeatAt'])
```

**New file: `convex/videoReactions.ts`**

Functions:
- `addReaction(bondfireId?, bondfireVideoId?, emoji, timestampMs)` — mutation. Validates exactly one video reference. Denormalizes userDisplayName + userPhotoUrl from users table. Returns created reaction or null on failure. No server-side throttle (client-side only).
- `getReactions(bondfireId?, bondfireVideoId?)` — query. Returns all reactions for a video sorted by timestampMs ascending.
- `getRecentEmojis(userId)` — query. Returns user's most frequently used emojis (aggregate from videoReactions by userId, group by emoji, count, sort desc, limit 4). Free users don't need this.

**New file: `convex/presence.ts`**

Functions:
- `heartbeat(videoType, videoId)` — mutation. Upserts presence row with denormalized user data. Uses `by_video_user` index to find existing row.
- `leaveViewing(videoType, videoId)` — mutation. Deletes presence row.
- `listViewers(videoType, videoId)` — query. Returns active viewers (lastHeartbeatAt > now - 65000). Client excludes self.
- `cleanupStalePresence()` — internal mutation. Deletes rows where lastHeartbeatAt < now - 65000.

**Modified file: `convex/crons.ts`**

Add:
```typescript
crons.interval('cleanup stale presence', { minutes: 1 }, internal.presence.cleanupStalePresence)
```

### PR 2: Frontend — Presence System

**New files:**
- `packages/app/src/hooks/usePresence.ts` — Hook managing heartbeat interval, leaveViewing on unmount/blur, reactive `useQuery(api.presence.listViewers)` subscription, client-side self-exclusion
- `apps/mobile/components/ViewerPresenceStack.tsx` — Unified avatar stack component (used by both presence and reactions; in this PR, only the persistent/live viewer layer is active)

**Modified files:**
- `apps/mobile/app/(main)/bondfire/[id].tsx` — Wire `usePresence` hook into `VideoPlayer` for the active video. Render `ViewerPresenceStack` in the left side below the back button (`top: ~100, left: 16`).
- `apps/mobile/components/create/LiveRecordScreen.tsx` — Render `ViewerPresenceStack` in the top-left below the X button (`top: ~110, left: 20`). Only render when `liveStatus === 'live'`.

**Hook design:**
```typescript
function usePresence(opts: {
  videoType: 'bondfire' | 'response'
  videoId: string | undefined
  isActive: boolean
  isScreenFocused: boolean
  isAppActive: boolean
  currentUserId: string | undefined
}): {
  viewers: Viewer[] // reactive list from useQuery, filtered to exclude self
}
```

**ViewerPresenceStack component:**
```typescript
interface ViewerPresenceStackProps {
  liveViewers: Viewer[]       // persistent viewers from presence
  activeReactions?: ActiveReaction[]  // transient reactions (empty in PR 2, populated in PR 3)
  style?: ViewStyle
}
```

The stack renders avatars vertically with:
- "watching" label under live viewers
- No label under transient reactions (PR 3)
- Adaptive spacing: gap decreases as count increases (normal gap → tight → overlapping)
- Scrollable when exceeding 5 visible avatars
- Tamagui `AnimatePresence` for enter/exit transitions (fade in/out)
- Empty state renders nothing

### PR 3: Frontend — Emoji Reactions

**New files:**
- `apps/mobile/components/EmojiReactionButton.tsx` — Trigger button (replaces Report position on right side). 44x44 pill, matches existing button style.
- `apps/mobile/components/EmojiReactionGrid.tsx` — Floating 4x4 grid + 4-slot recent column. Slightly transparent background. Lock icons for free-tier emojis. Auto-closes on selection.
- `apps/mobile/constants/emojis.ts` — `FREE_EMOJIS` (['🙏', '❤️', '🔥']), `ALL_EMOJIS` (16 emojis), `isFreeEmoji(emoji)` helper
- `apps/mobile/components/ReactionOverlay.tsx` — Manages reaction animation rendering within the ViewerPresenceStack (emoji scale growth via RN `Animated`, avatar enter/exit via Tamagui `AnimatePresence`)

**Modified files:**
- `apps/mobile/app/(main)/bondfire/[id].tsx` — Replace `ReportButton` on right side with `EmojiReactionButton`. Move `ReportButton` to left side above creator info (`bottom: ~200, left: 20`). Wire emoji tap → optimistic animation → Convex `addReaction` mutation. Load reactions via `useQuery(api.videoReactions.getReactions)`. Integrate `ReactionOverlay` with `ViewerPresenceStack` — pass active reactions to the stack. Monitor `player.currentTime` in the existing progress interval to trigger reaction animations at correct timestamps. Track which reactions have already animated this playback cycle. Skip during scrubbing.

**Emoji constants:**
```typescript
export const FREE_EMOJIS = ['🙏', '❤️', '🔥']
export const ALL_EMOJIS = [
  '🙏', '❤️', '🔥', '😂',
  '😮', '👏', '💪', '🙌',
  '💯', '✅', '👀', '🎉',
  '😢', '😍', '🤔', '👍',
]
export function isFreeEmoji(emoji: string): boolean {
  return FREE_EMOJIS.includes(emoji)
}
```

**Tier gating:**
- Import `useSubscription` hook, get `currentTier`
- `tierMeetsRequirement(currentTier, 'plus')` → paid access
- Free users: grayed + lock overlay on non-free emojis. Tapping locked → `showPaywall()` from subscription store
- Recent column for free users: always shows 3 free emojis
- Recent column for paid users: fetched from `getRecentEmojis` query, updated on each reaction

**Optimistic animation flow:**
1. User taps emoji → check throttle (5s since last reaction)
2. If throttled → ignore silently
3. If allowed → immediately trigger local animation: add reaction to `activeReactions` list with current user's photoUrl + emoji + current timestamp
4. Fire `addReaction` mutation in background (no await)
5. On animation complete (~1.5s) → remove from `activeReactions` list
6. On mutation failure → silent (no error toast, reaction just doesn't persist)

**Reaction playback flow:**
1. On video load/becoming active → `useQuery(api.videoReactions.getReactions, { bondfireId })` or `{ bondfireVideoId }`
2. In the existing progress interval (lines 331-347) → check if `player.currentTime * 1000` crosses any reaction's `timestampMs`
3. If yes and not already triggered this cycle → add to `activeReactions` list (triggers animation in ViewerPresenceStack)
4. If scrubbing (`isScrubbingRef.current`) → skip trigger
5. On video replay/loop → reset triggered tracking

**Live viewer + reaction merge logic:**
- ViewerPresenceStack receives both `liveViewers` and `activeReactions`
- For each active reaction, check if the reactor's userId matches a live viewer
- If match → render emoji overlay on that viewer's existing avatar (no duplicate avatar)
- If no match → render a transient avatar + emoji (enters via AnimatePresence, exits after ~1.5s)
- Live viewers always rendered on top of the stack, transient reactions below
- Order within transient reactions: by createdAt (received order)

**Animation approach:**
- Avatar enter/exit: Tamagui `AnimatePresence` with `enterStyle={{ opacity: 0, scale: 0.8 }}` / `exitStyle={{ opacity: 0, scale: 0.8 }}`, `animation="quick"` (spring, damping 20, stiffness 250)
- Emoji scale growth: RN `Animated.timing` — scale from 0.5 to 1.5 over 800ms, then both avatar + emoji fade via Tamagui exit after total ~1.5s
- Live viewer join/leave: Tamagui `AnimatePresence` enter/exit, `animation="lazy"` (spring, damping 20, stiffness 60)

**Adaptive spacing:**
- 1-2 avatars: gap=12
- 3-4 avatars: gap=6
- 5+ avatars: gap=0 (slight overlap via negative margin)
- Scrollable when exceeding available height (~5 avatars)

**Throttle implementation:**
- `lastReactionTime` ref in VideoPlayer
- On emoji tap: check `Date.now() - lastReactionTime.current < 5000` → if true, ignore
- If false: proceed, update `lastReactionTime.current = Date.now()`

**Patterns to follow:**
- Use `VIDEO_OVERLAY_COLORS` from `videoOverlayColors.ts` for all overlay UI
- Pill button: 44x44, borderRadius 22, matching mute button and report button style
- Legend State: `useObservable` for component state, `useValue` to read
- `useQuery`/`useMutation` from `convex/react` for Convex integration
- Tamagui `Avatar` component for avatar rendering (see `InviteSheet.tsx`)
- `Animated.timing` for imperative emoji scale animation (see existing `pendingPulse` pattern at line 895)

**Anti-patterns (do NOT do these):**
- DO NOT use React `useState` for complex state — use Legend State or refs
- DO NOT use Reanimated — use Tamagui animations + RN Animated (consistency with existing code)
- DO NOT create separate avatar stack components for presence and reactions — one unified `ViewerPresenceStack`
- DO NOT join the users table during presence or reaction playback queries — denormalized fields are the performance path
- DO NOT add server-side throttle (client-side only per product decision)
- DO NOT bloat bondfires/bondfireVideos tables with embedded data — separate tables
- DO NOT refactor the existing VideoPlayer component structure — add to it, don't restructure
- DO NOT send heartbeats more frequently than 30s
- DO NOT filter stale presence entries on the read path — the cleanup cron handles expiry
- DO NOT add presence to `feed.tsx` or `LegacyRecordScreen.tsx`

**Key files for reference:**
- `apps/mobile/app/(main)/bondfire/[id].tsx:778-800` — Right side controls (where emoji button goes)
- `apps/mobile/app/(main)/bondfire/[id].tsx:762-776` — Creator info (Report moves above this)
- `apps/mobile/app/(main)/bondfire/[id].tsx:290-350` — Progress tracking (reaction playback timing)
- `apps/mobile/app/(main)/bondfire/[id].tsx:895-905` — Existing Animated.timing pattern
- `apps/mobile/app/(main)/bondfire/[id].tsx:1467-1530` — Header layout (back button, viewer stack position)
- `apps/mobile/components/ReportButton.tsx` — Pill button style reference
- `apps/mobile/components/InviteSheet.tsx:219-231` — Avatar.Image + Avatar.Fallback usage
- `apps/mobile/components/create/LiveRecordScreen.tsx:958-980` — Recording screen header
- `packages/config/src/tamagui.config.ts:244-268` — Animation presets
- `packages/app/src/store/subscription.store.ts:358-362` — tierMeetsRequirement

## Complexity Budget

**Target tier:** Large
**Acceptable range:** 600-1500 net new production lines (excluding test code)

No complexity cap — the priority is a complete, bug-free, performant implementation. If it needs more lines to be done right, that's fine.

Estimated breakdown:
- `convex/schema.ts` — ~30 lines (2 new tables)
- `convex/videoReactions.ts` — ~80 lines
- `convex/presence.ts` — ~100 lines
- `convex/crons.ts` — ~3 lines
- `packages/app/src/hooks/usePresence.ts` — ~100 lines
- `apps/mobile/components/ViewerPresenceStack.tsx` — ~150 lines (unified stack with adaptive spacing)
- `apps/mobile/components/EmojiReactionButton.tsx` — ~30 lines
- `apps/mobile/components/EmojiReactionGrid.tsx` — ~150 lines
- `apps/mobile/components/ReactionOverlay.tsx` — ~100 lines
- `apps/mobile/constants/emojis.ts` — ~20 lines
- `apps/mobile/app/(main)/bondfire/[id].tsx` — ~200 lines (integration of all three systems)
- `apps/mobile/components/create/LiveRecordScreen.tsx` — ~40 lines
- Total: ~1003 lines

## Process

- **PR 1 (Backend):** Schema + Convex functions + cron. Review before proceeding.
- **PR 2 (Frontend Presence):** usePresence hook + ViewerPresenceStack (live viewer layer only) + recording screen integration.
- **PR 3 (Frontend Reactions):** Emoji button + grid + tier gating + reaction animation + playback integration + Report relocation + reaction layer in ViewerPresenceStack.
- PR 2 and PR 3 may be combined into a single frontend PR if the implementing agent judges it cleaner.
- Agent implements autonomously through completion of each PR.
- **Verification is the primary activity.** Walk through every scenario and Must Have criterion twice — once after building, once after tests.
- PRs target `main` branch.
- If stuck, try to resolve independently first. Escalate only if truly blocked.
- **Definition of done = all success criteria verified.**

## Open Questions

- [x] ~~What are the 16 emojis for the full grid?~~ — Confirmed: 🙏 ❤️ 🔥 😂 😮 👏 💪 🙌 💯 ✅ 👀 🎉 😢 😍 🤔 👍
- [x] ~~Auto-close after selecting an emoji?~~ — Yes, auto-close.
- [x] ~~Recent column size?~~ — 4 emojis to match 4-row grid height.
- [x] ~~Animation library?~~ — Hybrid: Tamagui AnimatePresence for enter/exit, RN Animated for emoji scale growth.
- [ ] Should PR 2 and PR 3 be combined or kept separate? (Implementing agent's discretion)