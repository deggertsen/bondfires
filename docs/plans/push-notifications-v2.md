# Push Notifications v2 — Rich Media, Summaries & Reliability

**Author(s):** David + Forge
**Date:** August 8, 2026
**Status:** In progress (implementation branch `agent/feat/push-notifications-v2`)
**Complexity:** Large

---

# ONE-PAGER

## Diagnosis

Our push notifications are functional but generic. They show the app icon for every notification, use impersonal copy ("New response", "Live now"), and don't surface the AI summaries we're already generating. The daily digest may not be firing for some users. This plan upgrades notifications to feel personal — sender avatars, video summaries in the body, better copy, and a more reliable digest.

## Current Gaps

- **No rich media:** Expo Push API doesn't support images. Every notification shows the default app icon, not the sender's avatar.
- **Generic copy:** Notification bodies don't include AI summaries even though we generate them (capped at 120 chars, perfect for push).
- **Impersonal summaries:** The AI summary prompt explicitly says "no speaker names" — summaries feel detached ("Shares news about the job" instead of "David shares news about the job").
- **Digest reliability:** Daily digest may not be firing for all users. Possible causes: missing timezone on device tokens, insufficient activity to trigger the 20h minimum age gate, or the hourly cron missing the user's local window.
- **Stale live-start copy:** Live notifications use generic "is sharing a Bondfire" text with no content preview, and there's no summary available at live-start (transcript isn't generated yet).

## Solution Summary

Migrate push delivery from Expo Push API to direct APNs (iOS) and FCM (Android) to unlock rich media support. Add an iOS Notification Service Extension via a config plugin to download and attach sender avatars. Include AI summaries in response and video-ready notification bodies. Fix the AI summary prompt to include speaker names. Investigate and fix the daily digest reliability issue. Keep live-start notifications using title-based copy (no summary available at that point).

## Not Doing (Out of Scope)

- **Two-notification approach for live-start:** Rejected — sending a follow-up notification when the summary is ready would feel spammy. Live-start keeps title-based copy.
- **Third-party push services (OneSignal, Courier, Braze):** Rejected — we want full control over the push pipeline for future rich media needs.
- **Changing the response throttle (1/hr per bondfire):** Out of scope for this plan. Hearth bondfires already bypass it; camp bondfires keep the current throttle.
- **Changing digest age windows (20h-96h):** The 20h minimum is by design (don't bug people immediately). Keeping as-is.
- **Report outcome notifications:** Still deferred until moderation resolution flow exists (carried over from v1 plan).

---

# VERIFICATION CONTRACT

## Success Criteria

### Must Have

- [ ] **Direct APNs delivery works for iOS pushes with rich media**
  - *Verify by:* Send a test push with `mutable-content: 1` and an avatar URL in the payload. Notification on iOS shows the sender's avatar instead of the default app icon.

- [ ] **Direct FCM delivery works for Android pushes with rich media**
  - *Verify by:* Send a test push via FCM v1 API with `BigPictureStyle` payload containing an avatar URL. Notification on Android shows the sender's avatar in expanded view.

- [ ] **All existing notification types still deliver after migration**
  - *Verify by:* Trigger each notification type (camp bondfire, response, live, hearth, membership, lifecycle, digest, nudge) and confirm receipt on both iOS and Android. No regressions.

- [ ] **Sender avatar appears in notifications for response, hearth, and membership notifications**
  - *Verify by:* Trigger a response notification. The push shows the responder's avatar. Trigger a hearth notification. The push shows the creator/joiner's avatar.

- [ ] **AI summary included in response notification body when available**
  - *Verify by:* A response video with a generated summary triggers a notification whose body contains the summary text (e.g., `David: Shares news about the new job and asks about the kids`).

- [ ] **AI summary prompt includes speaker names**
  - *Verify by:* Process a new video transcript. The generated summary includes the speaker's name (e.g., "David shares news about the job" not "Shares news about the job").

- [ ] **Live-start notifications keep title-based copy (no summary)**
  - *Verify by:* Start a live bondfire. The notification body uses the existing title-based format. No summary is included (transcript isn't available yet).

- [ ] **Daily digest fires for users with activity**
  - *Verify by:* Create test activity (unwatched response videos) for a test user. Wait for the user's digest window. Confirm the digest push arrives. Check server telemetry for `push:sendToUser:attempt` events with category `reminder`.

- [ ] **Device tokens store timezone data for new registrations**
  - *Verify by:* Register a new device token. Query `deviceTokens` table and confirm the `timezone` field is populated with an IANA timezone string (e.g., `America/New_York`).

- [ ] **Existing Expo Push tokens migrated to native APNs/FCM tokens**
  - *Verify by:* Client uses `getDevicePushTokenAsync()` instead of `getExpoPushTokenAsync()`. Backend `deviceTokens` table stores native tokens with `tokenType: 'apns'` or `tokenType: 'fcm'`.

- [ ] **Notification preferences still enforced server-side**
  - *Verify by:* Disable `responses` category in preferences. Trigger a response notification. No push arrives. Re-enable. Push arrives.

- [ ] **TypeScript compiles clean**
  - *Verify by:* `npx tsc --noEmit` passes with zero errors.

### Nice to Have

- [ ] **Avatar appears as a circular thumbnail on iOS (not just a rectangular attachment)**
  - *Verify by:* Visual inspection on device — avatar is circular, matches iMessage-style notification appearance.

- [ ] **Notification body uses relationship context when available**
  - *Verify by:* A recipient who has the sender in their Close Circle sees "from your Close Circle" language (already implemented for camp bondfires; extend to responses).

- [ ] **Digest includes summary text for single-item digests**
  - *Verify by:* Digest with one unwatched video includes the video's summary in the body (e.g., `David responded: Shares news about the new job`).

## Verification Scenarios

### Happy Path

1. **Given** a user has push permissions granted and a registered device token, **when** someone responds to their bondfire and the response video is ready (summary generated), **then** the user receives a push notification showing the responder's avatar, with body text including the AI summary and speaker name.

2. **Given** a user is in a camp, **when** a camp member starts a live bondfire, **then** the user receives a push notification with the camp name as title, the creator's name and bondfire title in the body, and the app icon (no avatar — live-start doesn't have a summary, and the avatar feature is for response/hearth/membership notifications).

3. **Given** a user has unwatched activity older than 20 hours, **when** the user's local digest window opens (their `digestHour` matches current local hour), **then** the user receives one digest push notification summarizing the waiting activity.

4. **Given** a user receives a Hearth bondfire notification, **when** the notification is displayed, **then** the creator's avatar appears as the notification image.

### Edge Cases

1. **Given** a sender has no `photoUrl` set, **when** a notification is sent with their avatar URL, **then** the notification falls back to the default app icon (no broken image).

2. **Given** a response video has no AI summary yet (transcript still processing), **when** the response notification fires, **then** the body falls back to the existing generic copy (`{responderName} added a video to a Bondfire you're in`).

3. **Given** a user's device token has no timezone, **when** the digest cron runs, **then** the user's digest fires at their UTC digest hour (fallback behavior, not a silent failure).

4. **Given** the iOS Notification Service Extension fails to download the avatar (network error, invalid URL), **when** the notification is displayed, **then** the notification still appears with the default app icon and standard body (no blank or broken notification).

5. **Given** a user has both an old Expo token and a new native token registered, **when** a notification is sent, **then** only the native token receives the push (no double delivery). Old Expo tokens are cleaned up during migration.

6. **Given** an Android device receives a rich push, **when** the notification is collapsed (not expanded), **then** the avatar is not shown but the title and body display normally. Expanding reveals the `BigPictureStyle` with avatar.

### Regression Checks

- All five notification preference categories still work (recording, responses, reminders, invitesAndMembership, hearth)
- Camp mute still suppresses notifications for muted members
- Close Circle personalized copy still works for camp bondfire notifications
- Notification delivery dedupe (per-video, per-thread throttle) still works
- Android notification channels still map to categories correctly
- Deep linking from notification tap still navigates to the correct bondfire
- Foreground notification handler still shows alerts when app is open
- `npx tsc --noEmit` passes clean
- Convex functions typecheck (`npx convex dev --typecheck`)

## Automated Tests

- **Behavioral test:** Response notification includes AI summary in body when summary exists
- **Behavioral test:** Response notification falls back to generic copy when summary is missing
- **Behavioral test:** Digest fires for user with qualifying unwatched activity in their digest window
- **Behavioral test:** Notification with no avatar URL falls back to default (no crash, no broken image)
- **Validation commands:** `npx tsc --noEmit`, `npx convex dev --typecheck`

---

# IMPLEMENTATION CONTEXT

## Required Reading

- `convex/sendNotification.ts` — Current push delivery via Expo Push API. This is the main file to migrate. Contains `sendToUser`, `sendExpoPushNotification`, all notification action functions.
- `convex/notifications.ts` — Device token registration, notification preferences, `resolveNotificationPrefs`.
- `convex/digest.ts` — Daily digest + 72h nudge system. `runHourlySweep`, `collectDigestItems`, `runDigestForUser`.
- `convex/ai.ts` — AI summary generation. `videoInsightsPrompt` (line 181) contains the "no speaker names" rule to change. `processVideoTranscript` is the entry point.
- `convex/schema.ts` — `deviceTokens`, `notificationDeliveries`, `bondfires`, `bondfireVideos`, `videoTranscripts`, `users` tables.
- `convex/crons.ts` — Cron definitions. Digest cron runs hourly at `:10`.
- `packages/app/src/hooks/usePushNotifications.ts` — Client-side push registration. `getExpoPushTokenAsync` → `getDevicePushTokenAsync` migration point.
- `packages/app/src/services/pushPermissions.ts` — Push permission bridge.
- `apps/mobile/app.json` — Expo config plugins. Currently has `expo-notifications` plugin.
- `.claude/CLAUDE.md` — Legend State patterns and conventions.
- `docs/plans/push-notifications.md` — v1 plan (IMPLEMENTED). Foundation context for what's already built.

## Strategy & Constraints

### Phase 1: Migrate to Direct APNs/FCM (Foundation)

**Goal:** Replace Expo Push API as the delivery mechanism with direct APNs and FCM calls. No rich media yet — just get native tokens flowing and direct delivery working.

**Client changes:**
- Switch from `Notifications.getExpoPushTokenAsync()` to `Notifications.getDevicePushTokenAsync()` in `usePushNotifications.ts`
- Update `registerDevice` mutation to accept `tokenType: 'apns' | 'fcm'` (instead of `'expo'`)
- Update the `tokenType` field in `deviceTokens` schema to include `'apns'` and `'fcm'`
- Keep `expo-notifications` library for receiving/handling notifications (it's push-service agnostic per Expo docs)

**Server changes:**
- Replace `sendExpoPushNotification()` in `sendNotification.ts` with two platform-specific senders:
  - `sendApnsPushNotification(tokens, payload)` — HTTP/2 to `api.push.apple.com`, JWT auth with Apple key
  - `sendFcmPushNotification(tokens, payload)` — HTTP to `fcm.googleapis.com/v1/projects/{project}/messages:send`, OAuth2 access token
- Update `sendToUser` to route by `tokenType`: group tokens by platform, send to each platform's sender
- Store APNs auth key and FCM service account JSON in Convex environment variables
- Handle APNs token feedback (invalid/expired tokens → delete from `deviceTokens`)
- Handle FCM delivery receipts

**iOS credentials needed:**
- Apple Push Notification key (`.p8` file) — not a certificate. Created in Apple Developer portal, stored as a Convex env var (base64-encoded).
- Key ID, Team ID, Bundle ID — all available from existing EAS config.

**Android credentials needed:**
- Firebase service account JSON — already have Firebase project (used for FCM via Expo). Download from Firebase Console, store as Convex env var.
- FCM project name — from the Firebase project.

**Migration approach:**
- Client sends both Expo and native token during a transition period (optional — simpler to just switch)
- Simpler: hard switch. Old Expo tokens stop receiving. Users re-register on next app open via `registerIfGranted()`. Acceptable for a small user base.
- Clean up old `tokenType: 'expo'` tokens from `deviceTokens` table after migration

### Phase 2: iOS Notification Service Extension (Avatar Support)

**Goal:** Add an iOS Notification Service Extension that downloads the sender's avatar and attaches it to the notification before display.

**Implementation:**
- Create a config plugin (or use the Expo example pattern from <https://github.com/expo/expo/pull/36202>) that adds a Notification Service Extension target to the iOS project during `expo prebuild`
- The extension is a small Swift/ObjC bundle that:
  1. Receives the push payload (with `mutable-content: 1`)
  2. Extracts the `avatarUrl` from the `data` field
  3. Downloads the image
  4. Attaches it as a `UNNotificationAttachment`
  5. Calls `contentHandler` with the modified notification
- The extension's bundle ID must be the main app's bundle ID + `.NotificationServiceExtension`
- Add `appExtensions` config to `app.json`/`app.config.js`

**Server changes:**
- APNs payload includes `mutable-content: 1` and the avatar URL in the `data` object
- Avatar URL must be publicly accessible (no auth required) — `photoUrl` on the users table is a Convex storage URL, which may need to be made public or proxied

**Fallback behavior:**
- If the extension fails to download the avatar (network error, bad URL), the notification displays with the default app icon. No crash, no broken image.

### Phase 3: Android Rich Push (Avatar Support)

**Goal:** Send FCM payloads with `BigPictureStyle` to show avatars on Android.

**Implementation:**
- FCM `notification` payload includes standard `title` and `body`
- FCM `data` payload includes `avatarUrl`
- Client-side `expo-notifications` or a custom Firebase messaging handler receives the data and builds a `BigPictureStyle` notification with the avatar image
- Alternatively, send the image URL in the FCM `notification.android.notification.image` field (supported by FCM v1 API) — Android system downloads and displays it automatically without app code
- The `image` field in FCM v1 `notification` payload: `"notification": { "android": { "notification": { "image": "https://..." } } }` — this is the simplest path and doesn't require client-side handling

**Image requirements:**
- Avatar images should be cropped to ~2:1 aspect ratio for Android (or accept that Android will crop)
- HTTPS URLs only (FCM requirement)
- Under ~1MB (FCM silently downsamples larger images)

### Phase 4: AI Summary in Notification Body

**Goal:** Include the AI-generated summary in response and video-ready notification bodies.

**Changes to `convex/ai.ts`:**
- Update `videoInsightsPrompt` (line 194): change "no speaker names" to "include the speaker's first name when known"
- New prompt rule: `summary: third person, present tense, concrete. Include the speaker's first name (e.g., "David shares news about the new job and asks about the kids"). No preamble.`
- This is a one-line change to the prompt. Existing summaries will be regenerated over time as new videos are processed. No backfill needed for v2 (old summaries still work, just without names).

**Changes to `convex/sendNotification.ts`:**
- `notifyBondfireResponse`: fetch the response video's `summary` field. If present, use it in the body:
  - With summary: `David: Shares news about the new job and asks about the kids`
  - Without summary (fallback): `David added a video to a Bondfire you're in`
  - For live response: keep existing live copy (no summary at live-start)
- `notifyBondfireLive`: no change (no summary at live-start, keep title-based copy)
- `notifyCampBondfire`: fetch the bondfire's `summary` field if available (for video-ready, not live-start). If present:
  - With summary: `David: Shares news about the new job and asks about the kids`
  - Without summary: existing copy
- Digest single-item body: include summary when available
  - With summary: `David responded: Shares news about the new job`
  - Without summary: `David responded in "Title"` (existing)

**New internal queries needed:**
- `getVideoSummary` — fetch the `summary` field from a `bondfires` or `bondfireVideos` record by ID. Used by notification actions to get the summary without loading the full document.

**Body length constraint:**
- iOS truncates push body at ~100-120 chars. Summaries are capped at 120 chars. With the name prefix (`David: `), total body could be ~130 chars. Accept truncation — the first 100 chars of a summary are the most informative.
- Android has similar limits in collapsed view; expanded view shows full body. Accept truncation in collapsed view.

### Phase 5: Digest Reliability Fix

**Investigation steps (before implementation):**
1. Query production `deviceTokens` table: count tokens with null/missing `timezone` field
2. Check `clientLogs` for `push:sendToUser:no_tokens` or `push:sendToUser:no_expo_tokens` events
3. Check `notificationDeliveries` for `digest:*` or `nudge:*` entries — are any being created?
4. Check if the `runHourlySweep` cron is actually running (server telemetry for cron execution)

**Likely fixes based on code review:**
- **Timezone backfill:** If existing device tokens are missing timezone, add a migration that backfills timezone from the client on next app open (the client already sends timezone on new registrations; old tokens may predate this)
- **Activity threshold:** If there's genuinely not enough activity yet, the digest has nothing to send. This is expected for early-stage. Consider lowering `DIGEST_MIN_AGE_MS` from 20h to 12h to surface activity sooner.
- **Token type filter:** After the APNs/FCM migration, update the `sendToUser` filter from `tokenType === 'expo'` to `tokenType === 'apns' || tokenType === 'fcm'`. This is handled in Phase 1 but critical to not miss.
- **Logging:** Add a `digest:sweep` telemetry event with counts: users checked, users in window, users with activity, digests sent. Currently there's no visibility into whether the sweep is running and finding candidates.

**No-code fix for low activity:** If the platform simply doesn't have enough video activity yet, the digest won't fire. This is correct behavior. The fix is growth, not code. But we should confirm this is the case vs. a bug.

### Phase 6: Notification Copy Polish

**Goal:** Make notification copy less generic across all notification types.

**Changes:**
- Response notifications: use summary when available (Phase 4), keep existing copy as fallback
- Hearth join: `{joinerName} joined your Bondfire` → include the bondfire context: `{joinerName} joined "{bondfireTitle}"` when title exists
- Access approved: `"{campName}" let you in` → `{campName} let you in — tap to look around` (slightly warmer)
- Lifecycle warnings: keep existing copy (already personalized with camp name and deadlines)
- Digest: include summary for single-item digests (Phase 4 nice-to-have)

**Patterns to follow:**
- Follow existing copy patterns in `sendNotification.ts` — title is context (camp name, "New response", "Live now"), body is the message
- Keep body under 120 chars where possible (iOS truncation)
- Always include the actor's name in the body (we already do this for most notifications)

**Anti-patterns (do NOT do these):**
- DO NOT add guilt-based copy ("You haven't checked your Bondfires in a while")
- DO NOT add emoji to push copy (keep it clean)
- DO NOT change notification sounds or add custom sounds (out of scope)

## Patterns to Follow

- Follow existing Convex patterns: internal queries for data fetching, internal actions for notification sending, `claimDeliveries` for dedupe
- Follow existing `sendToUser` pattern: single choke point for preference enforcement, then route to platform sender
- Follow existing config plugin pattern in `app.json` for new iOS extension
- Use Legend State patterns from `.claude/CLAUDE.md` for any client-side state changes

## Anti-patterns (do NOT do these)

- DO NOT create a new notification abstraction layer — extend the existing `sendNotification.ts`
- DO NOT refactor the notification preference system — it works, extend it
- DO NOT use `useState` for complex state (use Legend State per `.claude/CLAUDE.md`)
- DO NOT remove the `expo-notifications` library — we still use it for receiving/handling notifications
- DO NOT change the `notificationDeliveries` dedupe mechanism — it works
- DO NOT backfill old AI summaries — let them regenerate naturally as new videos are processed

## Key Files for Reference

- `convex/sendNotification.ts` — Main file to migrate. All notification actions and the `sendToUser` choke point.
- `convex/notifications.ts` — Token registration, preferences.
- `convex/digest.ts` — Digest system.
- `convex/ai.ts` — Summary generation. `videoInsightsPrompt` at line 181.
- `convex/schema.ts` — Schema definitions. `deviceTokens` table at line ~720.
- `convex/crons.ts` — Cron definitions.
- `packages/app/src/hooks/usePushNotifications.ts` — Client push registration.
- `apps/mobile/app.json` — Expo config and plugins.

## Complexity Budget

**Target tier:** Large
**Acceptable range:** 600-1500 net new production lines

If implementation approaches the upper bound, stop and simplify. The APNs/FCM migration is the biggest chunk; the summary and copy changes are small.

## Process

- Implement in phases (1 through 6 above). Each phase is independently shippable.
- Phase 1 (APNs/FCM migration) is the prerequisite for Phase 2 and 3 (avatars).
- Phase 4 (summaries) can be done in parallel with Phase 1.
- Phase 5 (digest fix) can be done in parallel with Phase 1.
- Phase 6 (copy polish) depends on Phase 4.
- **Verification is the primary activity.** Walk through every scenario and Must Have criterion twice — once after building, once after tests.
- PR targets `main` branch
- If stuck, try to resolve independently first. Escalate only if truly blocked.
- **Definition of done = all success criteria verified.**

## Open Questions

- [ ] Avatar URL accessibility: Are Convex storage URLs for `photoUrl` publicly accessible, or do they need signed URLs? If signed, the iOS Notification Service Extension and FCM image fetch need URLs that don't expire quickly (at minimum, valid for ~5 minutes after push send). (Forge to investigate)
- [ ] APNs key vs certificate: We need an Apple Push Notification key (`.p8`), not a certificate. Does the existing EAS push credential setup use a key or certificate? If certificate, we need to create a key in the Apple Developer portal. (Forge to check EAS config)
- [ ] Firebase project: Is the existing Firebase project configured for FCM v1 API? The migration from legacy FCM to v1 may require updating server credentials. (Forge to check Firebase Console)
- [ ] Digest activity threshold: Is the platform generating enough video activity for the digest to have content? If not, the digest is correctly silent. (David to confirm — this may just be a growth issue)
- [ ] Should we lower `DIGEST_MIN_AGE_MS` from 20h to 12h to surface activity sooner for a small user base? (David to decide)