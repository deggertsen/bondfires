# Reaction summaries and animations

**Status:** Draft
**Authors:** David (mavrick2424) + Forge
**Mockups:** https://claude.ai/artifact/VGifAHq6m4E4mRmt38J3BJ (chosen: option B chip; animation row: Fly-in and Player)

## Diagnosis

Timestamped emoji reactions already exist, but they are only visible while a video is playing. `videoReactions` stores one row per reaction (`emoji`, `timestampMs`, denormalized reactor). Playback replays them as a short avatar animation: the reactor's avatar appears in the left presence stack, its emoji scales from 0.5 to 1.5 over 800ms, and it is removed at 1.5s (`ViewerPresenceStack`). The animation is easy to miss, and nothing tells the viewer where in the video the reactions are. Nothing on a list tells the creator, or anyone else, that a reaction happened.

That misses the point of the feature. People do not rewatch their own videos to discover that someone reacted. The approved presence-and-reactions plan called this out and deferred it: feed indicators, thumbnail summaries, and reaction notifications were explicit non-goals of that work (`docs/plans/video-presence-and-reactions.md`).

This plan is that deferred summary, not a new reaction system. A person looking at a Bondfire in the feed, My Fires, a camp list, or the thread sheet can see which emojis landed and how many, without pressing play. Participants can also see that new reactions arrived since they last opened the thread.

The reactions should also feel alive. That earlier plan deferred the animations too; they are part of this one. When reactions have arrived, the emojis fly in, gather on the list row's summary chip, and settle into the count. During playback, replayed reactions also float up the screen, and the scrubber shows where they cluster so the viewer can see those moments coming and jump to them.

Evidence is from the current code, not from analytics. Confidence is high on the data model and the surfaces below. Confidence is low on how often reactions actually happen; the plan does not depend on a volume number.

## Goals

- On every Bondfire list row, a viewer sees the thread's top reactions and the total count, or sees nothing when the thread has no reactions.
- On every video row inside a thread, a viewer sees that video's own top reactions and total, distinct from the rest of the thread.
- A thread participant sees that reactions arrived after they last opened the thread, and that signal clears once the thread is opened.
- List screens do not load `videoReactions` rows to render these summaries.
- Playback continues to replay the individual, timestamped reactions it already replays.
- Fly-in: when a list row's thread total has gone up since this device last showed that row, the emojis fly in, gather on the chip, and the count ticks up to the total. Otherwise the chip renders already settled.
- Float: during playback, each replayed reaction also floats up from the react button on the right. The existing avatar replay on the left stays.
- Scrubber heatmap: when a playing video has reactions the viewer can see, a density strip above the scrub bar shows where they cluster. Each peak has its top emoji and count pinned above it. A marker pops as the playhead passes it, and tapping a marker seeks to that moment.
- With the OS Reduce Motion setting on, nothing animates: chips render settled, nothing floats, and the heatmap stays still.

## Out of Scope

- The separate live-arrival burst (the canvas's "Burst" board, an emoji popping *out* of the chip). A total that grows while a row is on screen replays the fly-in for the new reactions instead, so live arrivals are not silent.
- Push notifications, in-app notification rows, and digest copy for reactions. The original plan excluded them; batching is a separate decision.
- Reaction delete, edit, or undo by the reactor. Users still cannot remove a reaction.
- Changing who may react, the emoji set, the free/Plus lock, or the server rate limit.
- Showing reactor names or photos on list rows.
- Per-viewer counts that hide reactions from blocked or deleted users. Playback keeps that filter. The summary count may include a reaction the viewer cannot see replayed. Accepted for this slice.
- Camp-specific ranking or "most reacted" sort.

## Solution

Keep `videoReactions` as the source of truth for playback. Maintain a small denormalized summary next to the video, updated in the same mutation that inserts or deletes a reaction row. Lists read the summary off the document they already load.

Two scopes, because feed rows are threads and thread-sheet rows are single videos:

- The spark video's own summary lives on `bondfires` (`reactionTotal`, non-zero `reactionCounts`, `lastReactionAt`). Spark reactions already use `bondfireId`.
- Each response's own summary lives on `bondfireVideos` with the same shape.
- The thread rollup lives on `bondfires` (`threadReactionTotal`, `threadReactionCounts`, `threadLastReactionAt`, `threadLastReactorId`). A spark reaction updates the spark summary and the rollup. A response reaction updates that response and the parent rollup.

`reactionCounts` is an array of `{ emoji, count }` from the closed emoji set already enforced by `isReactionEmoji`, stored only for emojis with a count above zero, ordered by count. (An array, not an object keyed by emoji, so keys never have to be valid Convex field names and the order is stored.) The row shows at most the first three plus the total. Zero means render nothing, not an empty pill.

"New" does not get its own seen-state table. For a participant, the thread is new when `threadLastReactionAt` is greater than that viewer's `bondfireThreadReads.lastReadAt` (missing read means new, once a reaction exists), unless the latest reactor (`threadLastReactorId`) is the viewer. Without that exception, reacting while you watch would mark your own thread new as soon as you back out. Opening the thread already calls `markThreadRead`. Non-participants do not see the new marker. This reuses the catch-up read, so opening a thread to watch a new video also clears the reaction marker. That coupling is intentional for this slice.

This matches the existing `countResponse` / `uncountResponse` idea: one helper applies a signed count change, and deletion paths call it instead of a second accounting scheme. The helper is a no-op when the stored count is already zero, so cleanup can retry.

Absent summary fields mean zero. A paginated backfill walks existing `videoReactions` and applies the same helper before the UI depends on old threads looking correct. Shipping the UI before backfill is safe; those threads simply show no pill until the backfill reaches them.

Alternatives considered:

- Collect reactions while rendering each card. Rejected. `getReactions` already loads every row for one video and filters visibility. Doing that per feed row fights the read-cost work already in the feed.
- A separate summary table. Rejected for this slice. The list queries already return the parent documents, and the write set is small.
- Owner-only counts. Not selected. Anyone who can see the list row can already open the video and watch the reactions replay. Hiding the count from them keeps the original problem for everyone except the creator. Left open below in case product wants the narrower audience.

### Chip design (mockup option B)

The summary is one bordered chip on the row's metadata line, after the response count, styled like the camp-label pill. It holds up to three emojis and the total, for example "❤️🔥🙏 12". In the new-reactions state the chip gets a gold tint, a gold border, and a gold count. There is no separate dot. The thread sheet uses the same chip, smaller, at the end of each row's header line, before NOW / NEW / ✓. On crowded rows the camp label truncates first.

### Fly-in on list rows

This is client-only and reads only the summary fields the row already has.

- **When it plays.** A persisted local store (`reactionFlyIn.store.ts`, same pattern as `viewedBondfires.store.ts`) maps `bondfireId → threadReactionTotal last shown`. When the chip is laid out on screen (checked with `measureInWindow`), or its total grows while it is on screen, and its total is greater than the stored value (missing counts as 0), the row plays the fly-in from the stored value and stores the new total. A row first mounted off screen does not claim the animation, so it can still fly in on a later visit. If the total is equal or lower, the chip renders settled. A quiet feed therefore stays still, and a row animates again only after it gets more reactions. To keep a first launch with many reacted threads from animating everything at once, at most 4 rows that ask within 1.5s of each other animate. Any others store their totals and render settled.
- **What plays.** Up to 6 emojis, split by each emoji's share of `threadReactionCounts`, start from scattered points around the row. They fly to the chip's center, shrink, and fade in on landing, about 1.2s each and staggered 100ms apart. The chip starts dimmed and scaled down. It bumps as the last emoji lands, and the count steps up in thirds to the total (12 → 4, 8, 12). Rows that qualify on the same render stagger by about 300ms.
- **Where.** `ReactionChip` in `packages/ui`, used by `BondfireRow` (feed, My Fires, personal camp) and the camp screen's local row. Thread-sheet and thread-bar chips render settled; see Open Questions.
- **How.** `react-native-reanimated` (already a dependency), so the animation runs on the UI thread and a scrolling feed does not drop frames. Reduce Motion is read with Reanimated's `useReducedMotion`.

### Float during playback

This feeds off the same `activeReactions` events `VideoPlayer` already raises for the avatar replay, including the viewer's own optimistic reaction.

- Each event also spawns one floating emoji that rises from just above the right-side react button. It drifts up about 300px with a slight sway, then fades out over roughly 3s.
- The avatar replay in `ViewerPresenceStack` keeps its current behavior. The float is an extra layer, not a replacement.
- At most 8 floats run at once; older ones finish while new ones wait. This bounds the cost during a dense cluster. Floats never take touches.

### Scrubber heatmap

This is built from the reaction rows `VideoPlayer` already loads through `getReactions`, which are visibility-filtered. It does not use the summary fields. No new query.

- Bucket `timestampMs` into about 48 bins over the video's duration and smooth them into the density strip drawn above `VideoProgressBar`.
- Pick up to 3 peaks, at least 15% of the duration apart. Each peak's marker shows the most common emoji in that window and the reaction count.
- A marker pops (a brief scale-up) when playback progress crosses it. Tapping a marker seeks to about 1s before its first reaction and resumes playback.
- Hide the strip when there are no visible reactions, when the duration is unknown, and for live videos. Markers sit above the scrub bar's pan area so a tap does not start a drag.

Because the heatmap uses the filtered rows, its counts can be lower than the list chip's count, for the same reason the replay can be (see Out of Scope). Accepted.

## Verification Contract

### Must Have

- [ ] A saved reaction increases exactly one video summary and the parent thread rollup by one for that emoji.
  - Verify by: convex test that inserts a spark reaction and a response reaction through `addReaction`, then reads `bondfires` and `bondfireVideos`. Spark reaction changes both spark fields and thread fields. Response reaction changes the response fields and thread fields, not the spark fields.
- [ ] A rejected reaction does not change any summary.
  - Verify by: convex test for an unsupported emoji, a negative timestamp, a missing video, and the existing 10-per-10-seconds limit. Documents are unchanged after each rejection.
- [ ] Feed, My Fires, and camp list rows show at most three emojis and the thread total when `threadReactionTotal > 0`, and show no reaction UI when it is zero or the fields are absent.
  - Verify by: component test or story-level render of `BondfireRow` and the camp screen's local row with `{ "❤️": 4, "🔥": 2 }`, with a one-emoji summary, and with no summary. Inspect the row text. Also open those three screens against seeded data.
- [ ] The thread sheet shows each video's own summary, not the thread rollup.
  - Verify by: seed a spark with ❤️ and a response with 🔥. The sheet's spark row shows only ❤️ and the response row shows only 🔥. The feed row for that Bondfire shows both.
- [ ] A participant sees a new-reactions marker only when the thread's latest reaction is newer than their read marker, and opening the thread clears it.
  - Verify by: convex/component test around `markThreadRead` and the list decorator. Participant with `lastReadAt` older than `threadLastReactionAt` sees the marker. After `markThreadRead`, it is gone. A non-participant with the same timestamps does not see it. A thread with no reactions does not show it.
- [ ] Deleting a reactor's account removes their reaction rows and the same counts from the surviving video and thread rollup.
  - Verify by: convex test that creates reactions, runs the account-deletion reactions stage, and asserts the row is gone and both summaries decreased. A second run does not drive a count below zero.
- [ ] Deleting a response subtracts that response's reactions from the surviving Bondfire rollup. Deleting the Bondfire itself does not need a surviving rollup.
  - Verify by: convex test through the response retention/cleanup reactions stage. Parent `threadReactionTotal` drops by the deleted response's count. Spark summary on the parent stays put.
- [ ] Backfill reproduces the summaries that incremental writes would have produced.
  - Verify by: insert raw `videoReactions` without going through the helper, run the backfill page until done, and compare totals and per-emoji counts to a direct count of the rows.
- [ ] Playback still replays stored reactions at `timestampMs`, still hides reactions from users the viewer cannot see, and still ignores the new summary fields.
  - Verify by: existing `convex/videoReactions.test.ts` cases plus one case where the summary count is 1 but the only reactor is not visible to the viewer. `getReactions` returns an empty list. The list pill may still show 1.
- [ ] Fly-in plays only when a row's thread total grew since this device last showed it, and only up to the burst cap.
  - Verify by: unit test of the pure trigger helper (stored 0 or missing with total 12 → play; stored 12 with total 12 → settled; stored 12 with total 14 → play; 6 qualifying rows in one burst → first 4 play, the rest are stored and settled; a later burst plays again). Unit test of the flight builder: at most 6 emojis, proportional to counts, only keys from the summary.
- [ ] Fly-in lands on the right total and leaves the chip settled.
  - Verify by: device check on iOS and Android, feed and camp list, with seeded threads whose totals were bumped. After the animation the chip text matches the settled render exactly. Scrolling the feed during the animation stays smooth.
- [ ] Playback floats one emoji per replayed reaction, including your own, without changing the avatar replay.
  - Verify by: device check on a seeded video with a cluster of 5+ reactions. Count the floats, confirm no more than 8 are on screen at once, and check that the left stack behaves as before.
- [ ] The scrubber heatmap matches the visible reactions, pops markers on crossing, and seeks on tap.
  - Verify by: unit test of the bucketing/peak helper (timestamps → bins, peaks at least 15% apart, top emoji and count per peak, empty input → no strip). Device check: tap each marker and confirm the seek lands about 1s before the cluster. A video whose only reactor is blocked shows no strip.
- [ ] Reduce Motion disables all three animations.
  - Verify by: turn on Reduce Motion in the simulator. Rows render settled chips, playback shows no floats, the heatmap is static, and markers still seek.

### Scenarios

- Given a Bondfire with no reactions, when its row renders, then there is no emoji, no zero, and no new-reactions marker.
- Given a participant opens a thread after new reactions, when `markThreadRead` succeeds, then the list no longer marks that thread's reactions as new, including reactions on responses.
- Given the reactor is over the rate limit, when they send another emoji, then the mutation rejects and the displayed total stays the same after refetch.
- Given a response is removed by retention while the Bondfire remains, when cleanup finishes the reactions stage, then the feed total no longer includes that response and the thread sheet no longer lists it.
- Given a viewer has blocked the only reactor, when they open the video, then playback shows no reaction animation, even if the list pill shows a count.
- Given a thread got 2 new reactions while the app was closed, when the feed shows that row, then the emojis fly in once, the chip settles on the new total, and scrolling away and back does not replay it.
- Given a video with reactions at 0:05 and 0:40, when the viewer taps the 0:40 marker, then playback seeks to about 0:39 and the marker pops as it passes.

### Regression Checks

- Emoji grid, free-tier lock, Plus gate, and optimistic in-player animation stay as they are.
- The scrub bar still drags and seeks the same way when the heatmap is shown or hidden, and captions still sit clear of the strip.
- `getRecentEmojis` still ranks from `videoReactions`, not from the summary.
- `videoCount`, response counts, and thread unread video behavior do not change when a reaction is added.
- `markThreadRead` is still limited to thread participants.
- From the repo root, `yarn typecheck` and `yarn test` pass. Targeted reaction tests live in `convex/videoReactions.test.ts`; new summary tests should sit beside them.

## Implementation Context

### Required Reading

- `docs/plans/video-presence-and-reactions.md` — approved behavior this work must not reopen; feed summaries were explicitly deferred there.
- `convex/schema.ts` — `videoReactions`, `bondfires.videoCount`, `bondfireVideos`, `bondfireThreadReads`.
- `convex/videoReactions.ts` — `addReaction` and `getReactions`, including the visibility filter and the 10-per-10-seconds limit.
- `convex/lib/emojis.ts` — closed emoji set. Summaries must not invent emoji keys outside it.
- `convex/responseCounts.ts` — existing increment/decrement pattern to copy, including idempotent uncount.
- `convex/accountDeletion.ts` — reactor cleanup deletes `videoReactions` by `by_user_created` and does not touch a parent summary today.
- `convex/retentionCleanup.ts` — video cleanup deletes reactions by `by_bondfire` / `by_bondfire_video` before the parent row is fully gone.
- `convex/conversations.ts` — `markThreadRead` writes `bondfireThreadReads.lastReadAt`.
- `packages/ui/src/BondfireRow.tsx` — shared feed and My Fires row. The response count sits on the metadata line; the reaction pill belongs with that line, not over the 74px thumbnail.
- `apps/mobile/app/(main)/(tabs)/feed.tsx` and `apps/mobile/app/(main)/(tabs)/my-fires.tsx` — map query docs into `BondfireRow`.
- `apps/mobile/app/(main)/camp/[id].tsx` — local `BondfireRow`, not the shared component. It needs the same summary or camp lists will disagree with the feed.
- `apps/mobile/app/(main)/bondfire/_components/ThreadBrowser.tsx` — per-video rows, 54–68px, no thumbnail. Summary has to be a compact text pill.
- `apps/mobile/app/(main)/bondfire/_components/VideoPlayer.tsx` and `apps/mobile/components/ViewerPresenceStack.tsx` — playback replay that must keep working.
- `convex/bondfires.ts` `decorateFeedPage` — feed rows already do bounded per-row reads. The new marker should piggyback here rather than collect reactions.
- `apps/mobile/app/(main)/bondfire/_components/VideoPlayerOverlays.tsx` — `ReactionPresenceLayer` (left stack at top 100) and `VideoProgressBar` (bottom 100 + inset, pan handlers on the bar). The heatmap strip and its markers attach here. `CaptionOverlay` sits 152px above the bottom inset and may need to move up when the strip is shown.
- `packages/app/src/store/viewedBondfires.store.ts` — persisted per-bondfire map; copy the pattern for the fly-in "last shown total" store.
- `react-native-reanimated` `useReducedMotion` — the Reduce Motion source for the new animations. (`UploadStatusBanner.tsx` has its own older hook for RN Animated.)

### Constraints and Existing Patterns

- A reaction references exactly one of `bondfireId` or `bondfireVideoId`.
- There is no user-facing reaction delete. The only removals found are account deletion of the reactor and video retention/cleanup.
- Summary fields should be optional so existing documents stay valid. Readers treat missing as zero.
- Convex mutations are transactional. The reaction insert and the summary patch belong in one mutation so a failed write does not leave a row without a count, or a count without a row.
- Do not call `getReactions` from list queries.

### Risks

- Summary drift if a new delete path forgets the helper. Mitigation: one helper used by `addReaction`, account deletion, and retention cleanup; tests cover each caller.
- The list count can be higher than the reactions playback shows after a block or deletion race. Accepted above. Do not "fix" it by filtering inside the list query.
- Reusing `lastReadAt` means catching up on videos clears the reaction marker, and opening the thread for reactions marks videos read too. Acceptable for this slice; a separate reactions watermark is only worth it if that coupling shows up in use.
- Backfill on a large table must be paginated. It should be rerunnable and must not double-apply if the incremental helper already counted a row. Mitigation: backfill computes from reaction rows and writes absolute summaries for the videos it touches, or it only fills documents whose summary is still absent. Pick one and test the rerun.
- Animation cost on long feeds. Mitigation: Reanimated on the UI thread, a per-mount cap, a visibility trigger, and at most 6 flying emojis per row.
- The fly-in store is per device, so the same new reactions animate once on each device. Acceptable; it is decoration, not state.
- Heatmap markers and the scrub bar compete for touches. Mitigation: markers sit outside the pan responder's area; covered by the scrub regression check.

## Open Questions

- [ ] Counts on list rows are visible to everyone who can see the row, not only the video owner. Owner: David. Change this before implementation if the pill should be owner-only.
- [ ] No reaction notification in this slice. Owner: David. Confirm that stays deferred.
- [ ] The new-reactions marker is for every thread participant, not only the creator. Owner: David. Narrow it if only the creator should see it.
- [ ] Fly-in trigger: once per increase in the thread total, per device, at most 4 rows per 1.5s burst. Owner: David. The alternative is to play it on every feed open for threads with unread reactions.
- [ ] Should thread-sheet chips also fly in when the sheet opens, or stay settled as drafted? Owner: David.
- [ ] The separate pop-out "Burst" for live arrivals: is the replayed fly-in enough? Owner: David.
