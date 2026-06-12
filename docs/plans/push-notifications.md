# Push Notifications Plan

Status: IMPLEMENTED (phases 0–4) · June 2026 · branch `push-notifications`
Only remaining item: report-outcome notification, deferred until a report
resolution flow exists.

## Principles

1. **One push per video.** A recipient gets notified about a given video exactly once, at the earliest watchable moment. Publish-time sends are suppressed for anyone already notified at live-start.
2. **Notify when watchable, not at record tap.** Fire on Mux `video.live_stream.active` (current `notifyBondfireLive` timing). Tapping immediately always lands on something playable, and instantly-discarded recordings mostly never notify.
3. **Copy covers live and later.** Recipients shouldn't need to know whether they caught it live. Deep links resolve live → replay seamlessly.
4. **Camp mute is absolute; Hearths bypass.** Muted camps never notify. Hearth (personal camp) bondfires always notify participants — Hearths are small, high-trust, and have no mute concept.
5. **Reminders are capped and cancellable.** Max one reminder per video, cancelled if watched, batched when multiple are pending.
6. **Ask for permission at a high-intent moment.** The OS dialog is one-shot on iOS — never burn it on a contextless prompt at sign-in. Ask right after the user's first recording, when "someone might respond to you" is concrete.

## Current state

All senders live in `convex/sendNotification.ts` (Expo Push API, `deviceTokens` table).

| Type | Trigger | Recipients |
|---|---|---|
| `camp_bondfire` / `camp_crisis` / `camp_welcome` | publish (`bondfires.ts:555`, `videos.ts:912,1801`) | active non-muted camp members, minus creator |
| `bondfire_response` | publish (`bondfireVideos.ts:243`, `videos.ts:939,2741`) | thread participants or personal-bondfire participants, minus responder; camp mute respected |
| `bondfire_live` | Mux `live_stream.active` webhook (`videos.ts:3204`) | camp members only (no recipients without `campId`); new bondfires only (`!bondfireVideoId`) |
| `bondfire_invite` | direct share (`bondfireInvites.ts:220`) | invited user |
| `camp_access_request` | join request (`camps.ts:657`) | camp owner (push + Resend email) |

### Known problems

- **Double notification:** a live camp bondfire fires `bondfire_live` at stream-active *and* `camp_bondfire` at publish. This is the primary bug to fix.
- **Live responses never notify at live time** (`!bondfireVideoId` guard) — recipients only hear at publish.
- **New Hearth bondfires likely notify nobody:** `notifyCampBondfire` skips when `campId` is absent, and `bondfire_live` has no recipients without a camp. (Verify; responses in Hearth bondfires do notify.)
- **Access requesters never learn the outcome** of their request.
- No reminders, no per-type preferences (only global toggle + per-camp mute).
- **OS permission dialog fires at sign-in:** `_layout.tsx:333` observes `isAuthenticated` and calls `requestPermissions()` immediately (`notificationsEnabled` defaults `true` in `app.store.ts`). Zero context, lowest intent, and iOS only allows one system prompt — a deny here is near-permanent. `create.tsx`'s `requestPermissions` is camera/mic only.

## Phase 0 — Permission priming

Stop auto-prompting at sign-in. Split registration from permission-asking:

- **At sign-in:** silently register the token only if permission is *already granted* (the mount check in `usePushNotifications` already does this). Never trigger the OS dialog.
- **On the finished-recording screen, first time, right after the user commits** (publish/queue tap or success state): show an in-app pre-prompt sheet — *"Want to know when someone responds to you?"* with Yes / Not now. Yes → fire the OS dialog. This is the highest-intent moment: they're looking at the video they just put out and want responses. Anchoring to the commit (not screen-appear) means we never prime someone who's about to discard, and the prompt doesn't compete with the title/publish actions. Applies to first recording of any kind — new Bondfire or response.
- **Fallback triggers** if the user skipped or hasn't recorded: joining a camp or Hearth, sending a bondfire invite, requesting camp access. Same pre-prompt pattern, copy adapted ("Want to know when {camp} sparks a new Bondfire?").
- **Caps:** track `pushPrimerLastShownAt` / `pushPrimerDeclineCount` in `appStore$`; never re-prime within 7 days, stop after ~3 declines. If the OS dialog was denied, route "enable notifications" taps to system Settings instead.
- The in-app pre-prompt protects the one-shot OS dialog: only users who already said yes in our UI ever see it.

## Phase 1 — Unified recording notification + dedupe

The core change. One notification per video, sent when the stream becomes watchable (live recordings) or at publish (upload-queue videos, which have no live moment).

**Dedupe mechanism.** New table:

```
notificationDeliveries: defineTable({
  userId: v.id('users'),
  videoKey: v.string(),        // bondfireId or bondfireVideoId
  threadKey: v.string(),       // bondfireId — for per-thread throttling
  sentAt: v.number(),
})
  .index('by_video_user', ['videoKey', 'userId'])
  .index('by_user_thread', ['userId', 'threadKey'])
```

At live-start, record a delivery per recipient. At publish, `notifyCampBondfire` / `notifyBondfireResponse` skip recipients with an existing delivery for that video. Publish-time sends still cover: upload-queue videos, recipients who joined the camp mid-stream, and live notifications that failed.

**Response throttle: max 1 response notification per bondfire per recipient per hour.** Before sending a `bondfire_response` push, check `by_user_thread` for a delivery in that thread within the last hour; skip if found. Throttled responses are absorbed silently — recipients see them in-thread when they open (and the daily digest catches anything unwatched). An active back-and-forth must not become a push storm. The throttle applies to responses only, not new bondfires or invites.

**Extend live-start coverage** (currently camp bondfires only) to:

- Response recordings: drop the `!bondfireVideoId` guard; route recipients through `getResponseNotificationRecipientIds`.
- Hearth bondfires: recipients are the **active participants of that specific bondfire** (`personalBondfireParticipants`), not all Hearth members. Notifications stay localized to the conversation; mute does not apply (Hearths aren't camps).

**Copy** (title-first flow means the title exists at record time):

- New camp bondfire: `{Camp}` / `"{Title}" — {Name} is sharing a Bondfire. Watch live or later.`
- Response: `New response` / `{Name} is responding in "{Title}". Watch live or later.`
- Hearth: `{Hearth name}` / same patterns.
- Crisis/welcome variants keep their existing copy, sent at live-start instead of publish.

**Deep linking:** notification data already carries `bondfireId`/`campId`. The target screen must render live if live, replay/processing state otherwise — no second "replay ready" push.

**Abandoned recordings:** stream goes active then user discards → notification already sent. Accept this; deep link falls back to the thread/camp. If discard-after-active turns out to be common, add a ~10s sustained-recording threshold before notifying (decided against for v1 to keep live viewers fast).

## Phase 2 — Unwatched reminders

Scope: **any unwatched activity in threads the user is in** — responses to their bondfires and responses in bondfires they've participated in (creator or prior responder). Not unopened camp bondfires (revisit later).

Mechanics — **daily digest window**, not rolling per-video timers:

- A daily cron (Convex scheduled function) sends in each user's **local time** (e.g. 5–7pm). Requires capturing device timezone: client sends `Intl.DateTimeFormat().resolvedOptions().timeZone` with token registration; add `timezone` to `deviceTokens` and the `registerDevice` mutation. Run the cron hourly and select users whose local window it is.
- For each user, collect thread activity older than ~20h that is still unwatched (`bondfireThreadReads` / `watchEvents`). Skip anything in a thread the user has opened since — a read marker means they saw it and chose; don't nag.
- Send **one digest push** per user per day: `{Name} responded in "{Title}"` for a single item, `3 new videos waiting in your Bondfires` for multiple.
- **72h follow-up:** if after 72h the items are still unwatched *and the user hasn't opened the app at all in that window*, send one final nudge (`Your Bondfires miss you — 3 videos waiting`). App-open kill switch: any session within the 72h cancels it. This is the last touch — no further reminders for those items.
- Each video appears in at most one digest + at most one 72h nudge. Camp mute respected; Hearth content included.

## Phase 3 — Lifecycle and outcome notifications

In priority order:

1. **Access request approved** ✅ — push + email: `{Camp} let you in` / `You're now a member. Tap to look around.` Denied: **silent** (decided). Hooked in `approveAccessRequest` and `updateMemberStatus` (pending→active).
2. **Hearth join** ✅ — bondfire creator notified when someone redeems an invite into their Hearth bondfire.
3. **Camp lifecycle warnings** ✅ — push + email to owner on grace / frozen / inactive transitions, plus a daily-cron final warning 3 days before the reclaim deadline. All idempotent via `claimDeliveries` (`campstage:` keys).
4. **Close Circle posts** ✅ — recipients who pinned the creator get personalized copy ("{Name} from your Close Circle…") on camp bondfire + live notifications; mute still applies. New `by_pinned` index on `closeCirclePins`.
5. **Report outcome** — DEFERRED: reports currently have no resolution flow (only `submit` + admin email), so there is no event to hook. Revisit when moderation resolution lands.

## Phase 4 — Preferences ✅

Implemented as four per-category toggles + digest window picker, stored in
`users.notificationPrefs` and enforced server-side in `sendToUser` (every
push is tagged with a category; the choke point drops disabled ones):

- `recording` — camp bondfires, responses, live
- `reminder` — daily digest + 72h nudge (plus `digestWindowHour`, picker
  offers 8am / noon / 5pm / 8pm local; default 17)
- `membership` — bondfire invites, access requests/approvals (the approval
  email follows the same preference, so push/email stay consistent)
- `hearth` — Hearth bondfires, responses, joins (default on)
- `account` — camp lifecycle warnings; always delivered, no toggle

UI: `NotificationPreferencesSection` under the master Notifications switch
in profile settings. The master switch still controls token registration
entirely; categories refine what reaches a registered device.

Note: "Live" did not get its own category — live and publish are the same
notification now (one push per video), so a separate toggle would be
meaningless.

## Decisions log (June 11, 2026)

- Notify when stream is watchable, not at record tap, not after a sustained-recording delay.
- Reminder scope: any unwatched activity in threads the user participates in.
- Camp mute always respected; Hearth bondfires bypass mute semantics (not technically camps).
- One notification per video; publish suppressed per-recipient after live-start delivery.
- Permission ask: contextual pre-prompt on the finished-recording screen the first time the user commits a video of any kind — new Bondfire or response ("Want to know when someone responds to you?"), not at sign-in. OS dialog only after in-app yes.
- Nudge/digest copy is concrete ("3 videos waiting"), never guilt-based.
- Digest window will be user-configurable in Phase 4 (default 5–7pm local).
- Response notifications throttled at 1 per bondfire per recipient per hour; throttled responses absorbed silently.
- Digest sends in per-user local time; device timezone captured at token registration.
- 72h nudge confirmed (fires only if the user hasn't opened the app at all in the window). David explicitly accepts uninstall risk over silent dormancy.
- Hearth notifications localized to the specific bondfire's participants, not all Hearth members.
- Reminders: daily digest window (one push/day) + final 72h nudge only if the user hasn't opened the app at all in that window.
- Access denial: silent.
- Access approval and camp lifecycle warnings: push + email.

## Open questions

None blocking — all product decisions resolved as of June 11, 2026. Remaining choices (exact copy strings, default digest window time) can be settled in implementation review.
