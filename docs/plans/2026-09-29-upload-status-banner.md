# Upload In-Progress Status Banner

**Status:** Approved — Phase 1 implemented with mockup concept A, "Ember Strip" ([mockups](https://claude.ai/artifact/R2XUeqVYU7pXV7fFpTMvga))
**Authors:** David + Forge
**Date:** 2026-09-29
**Complexity:** Small–Medium (one new derived store, one component, one layout wire-up)

---

## Diagnosis

A user recorded a Bondfire response on a poor connection, left the app, came back, and concluded the recording was lost. It wasn't: the media was still on the device and finished uploading later. The app never told him that.

Two things are true today, and together they produce the "my video disappeared" report:

1. **Nothing durable says "your recording is still on its way."** The upload queue is real and crash-safe, but the only UI that reads it is `UploadProgressCard`, which renders **only on the Profile tab** (`apps/mobile/app/(main)/(tabs)/profile.tsx:669`). The segmented-recording path (the one production and internal builds ship — `EXPO_PUBLIC_SEGMENT_MEDIA=1`, `apps/mobile/eas.json:61,75`) has **no upload UI at all** after the completion screen is dismissed. Toasts are transient (6s auto-dismiss, max 3 visible — `packages/app/src/store/toast.store.ts`) and are not a status surface.

2. **The reassurance that does exist is thrown away on Continue.** Both capture paths tell the user their video is saved and still uploading *while the completion screen is on screen* (`apps/mobile/components/create/SegmentRecordScreen.tsx:300-313`, `apps/mobile/app/(main)/create.tsx:829`). The moment the user taps Continue, `onContinue` dismisses the stack and replaces to the Feed (`create.tsx:832-845`). From then on the app shows nothing — even though the upload is still running in the background and will resume on next launch.

So the upload is working as designed and the *communication* is what's missing. The fix is a persistent, top-of-app status surface fed by upload state we already track.

### Verified mechanics (what actually happens today)

- **Segmented/R2 path (current production + internal).** Native capture writes fragments to `<documents>/segments/<localId>/` with a journal at `<documents>/segment-uploads/<localId>.json`. `runSegmentUploads` (`apps/mobile/lib/media/segmentUploads.ts:123`) drains them sequentially and is driven by `SegmentUploadResume` in `apps/mobile/app/(main)/_layout.tsx`, which ticks every 2s whenever the user is signed in. Server status comes from `api.segmentMedia.getOwnRecording` (`convex/segmentMedia.ts:141`), which reports the linked bondfire/response `videoStatus`: `waiting_for_upload | live | ready | errored`.
- **Legacy single-file Mux path (older clients / live-publish builds).** MMKV-persisted `uploadQueueStore$` (`packages/app/src/store/uploadQueue.store.ts`) with `pending | processing | uploading | completed | failed`, plus `progress` (0–100) and a human-readable `stage`. Retries with exponential backoff (5 attempts), resume via `resumePendingUploads`.
- **Live-backup recovery** rides the same queue as `live_backup` tasks, enqueued at launch by `useLocalBackupSweep` (`packages/app/src/hooks/useLocalBackupSweep.ts`) with `autoStart: true`.
- **A real resume gap on the legacy path:** `useResumeUploads` exists but is **not used anywhere**; `resumePendingUploads` is only invoked from `create.tsx`'s `schedulePendingUploads`, i.e. after the user visits and then leaves the create screen. On a cold launch, legacy pending tasks don't resume until the create screen is mounted and blurred. The segment path does not have this problem (global 2s tick).

That legacy gap is worth fixing in the same breath, but it is a separate, small change — see Out of Scope.

---

## Goals

- After any recording, the app shows a persistent status surface whenever an upload/processing job for the current user is still in flight, so "not visible in the feed yet" cannot be read as "lost."
- The surface survives navigation and app restart, and reflects the real state: uploading, waiting for connection, retrying, failed, or finished.
- When the job completes, the user gets one clear confirmation that the video is now live.
- Users can force a retry without leaving the screen they're on.
- Works for all three job sources: segmented capture, legacy queue tasks, and live-backup recovery.

## Out of Scope

- **Progress percentage for the segmented path.** Fragment uploads expose no meaningful percentage today; Phase 1 shows indeterminate progress plus stage text.
- **Background execution while the app is closed** (`expo-background-fetch` / `expo-task-manager` are dependencies but are not registered anywhere). Phase 1 only resumes when the app is foregrounded. Noted as Open Question #3.
- **Fixing the legacy resume-on-cold-launch gap** (above). Same feature area, different mechanism; propose a follow-up unless it falls out of Phase 1 for free.
- Changing completion-screen copy or the Profile `UploadProgressCard`.
- Server-side changes. Everything needed already has a query or a local source.

---

## Solution

One derived read model + one presentational banner, wired once in the main layout.

### 1. A single derived store: `uploadStatusStore$` (packages/app/src/store/uploadStatus.store.ts)

Normalize the three sources into one shape, computed in a pure function so it is unit-testable without React or native modules:

```ts
type UploadStatusState =
  | { kind: 'idle' }
  | { kind: 'uploading'; count: number; label: string; stage?: string; progress?: number; source: 'segment' | 'queue' }
  | { kind: 'paused';   count: number; label: string; reason: 'offline' | 'retrying' }
  | { kind: 'failed';   count: number; label: string; message?: string }
  | { kind: 'completed'; label: string; at: number }
```

- **Queue source (legacy + live_backup):** read `uploadQueueStore$.tasks` directly — it is already reactive and already carries `status`, `progress`, `stage`, `taskType`, and `attemptCount`.
- **Segment source:** `segmentUploads.ts` already enumerates the journal directory every 2s; have `runSegmentUploads` publish a summary (`pendingCount`, `activeLocalId`, `stage`, `paused`, `lastProgressAt`) into the store instead of adding a second scan. This is the smallest change with no new IO.
- Derivation priority: `failed` > `paused` > `uploading` > `completed` > `idle`, with a completion hold of ~5s before returning to `idle`.

### 2. `UploadStatusBanner` (packages/ui/src/UploadStatusBanner.tsx)

Presentational component, theme-aware, same visual language as `UploadProgressCard` and `CampCardStatusBanner`.

| State | Icon | Copy (draft) | Action |
| --- | --- | --- | --- |
| `uploading` | `CloudUpload` | "Your response is still uploading. You can keep using the app — we'll finish it in the background." (+ `stage`, + `%` when known) | Tap → retry now |
| `paused` (offline) | `WifiOff` | "Waiting for a connection. Your recording is saved on this device and will upload automatically." | Tap → retry now |
| `paused` (retrying N/5) | `RefreshCw` | "Upload paused — retrying (attempt N of 5)." | Tap → retry now |
| `failed` | `AlertTriangle` | "We couldn't finish uploading your recording. Your video is still saved on this device." | Tap → retry now |
| `completed` | `CheckCircle2` | "Your video finished uploading and is live now." | Auto-hide after ~5s |

"Bondfire" replaces "response" for non-response jobs, decided by the same predicate the card uses (`isResponse` / `taskType`).

### 3. Placement: `apps/mobile/app/(main)/_layout.tsx`

Render the banner once, absolutely positioned, honoring `useSafeAreaInsets().top`, gated **off** when:

- the recording resource lock is held or the create route is focused (never overlay the camera or a recording state), and
- the user is not signed in.

This single mount point covers the tabs and every pushed `(main)` screen (bondfire detail, camp, personal-camp, family-connections) with no per-screen work.

### 4. Retry action

Tap calls a new `retryPendingUploads()` in `packages/app` that: (a) kicks `runSegmentUploads` for the segment path, and (b) calls `resumePendingUploads` for the legacy path. Both are already idempotent and resource-lock gated.

---

## Verification Contract

### Must Have

- [ ] A backgrounded response/legacy upload shows the banner on the Feed within one tick of leaving the create flow.
  - Verify by: device run — record with airplane mode toggled on during stop, navigate to Feed, confirm banner renders with `paused` (offline) copy.
- [ ] The banner survives navigation and app restart.
  - Verify by: record, force-quit mid-upload, relaunch, confirm the banner reappears from persisted state (MMKV queue and/or journal directory).
- [ ] `completed` state shows once and auto-hides; it does not stick across launches.
  - Verify by: restore connectivity, wait for completion, confirm confirmation copy, then relaunch and confirm idle.
- [ ] Tap-to-retry starts an upload immediately when online.
  - Verify by: with a queued task and connectivity restored, tap the banner and confirm upload activity resumes without visiting the create screen.
- [ ] Banner never renders during recording or on the create route.
  - Verify by: hold the recording resource lock (record with the live path) and confirm no banner appears over the camera or completion screen.
- [ ] Derivation is unit-tested as a pure function.
  - Verify by: new `packages/app`/`apps/mobile/test` suite covering idle/uploading/paused/failed/completed inputs from both sources, including priority ordering and multi-task counts.

### Scenarios

- Given one segmented job `waiting_for_upload` and no connectivity, when the user lands on Feed, then the banner shows the offline/paused copy and never the error copy.
- Given a legacy task at attempt 3/5, when the banner renders, then it names the retry attempt rather than the generic stage string.
- Given the app is killed with a pending journal, when it is relaunched, then `SegmentUploadResume` resumes the job and the banner reflects `uploading` within ~2s.
- Given a `live_backup` recovery task (Phase 2 of `docs/plans/local-backup-recording.md`), when it is enqueued at launch, then the banner appears alongside the existing one-time recovery toast and does not duplicate its message.
- Given multiple pending jobs, when both are in flight, then the banner shows a count rather than flickering between labels.

### Regression Checks

- Profile's `UploadProgressCard` keeps its current behavior and placement (`apps/mobile/app/(main)/(tabs)/profile.tsx:669`) — no shared-state regressions.
- Completion-screen detail copy is unchanged; the banner adds information, it does not replace the post-recording explanation.
- The recording resource lock still gates `resumePendingUploads` / `runSegmentUploads`; no upload work starts while the camera/encoder path is active.
- Toasts are not suppressed by the banner (see Risks for the collision mitigation).
- `yarn validate` passes (typecheck, test, `check:convex-generated`, `check:repo`, `check:app-links`, `check:security`, `check:release-foundation`, biome). New env vars, if any, registered in `repository-intelligence.json`.

---

## Implementation Context

### Required Reading

- `packages/app/src/store/uploadQueue.store.ts` — legacy/live_backup task shape and retention windows.
- `packages/app/src/services/backgroundUpload.ts` — statuses, `stage` strings, retry ladder, `resumePendingUploads`.
- `apps/mobile/lib/media/segmentUploads.ts` — journal layout, the 2s drain loop, `UploadFailure` → "paused" semantics.
- `apps/mobile/app/(main)/_layout.tsx` — `SegmentUploadResume` / `LegacyRecordingMaintenance` mount point; where the banner goes.
- `apps/mobile/components/create/SegmentRecordScreen.tsx:300-313` and `apps/mobile/app/(main)/create.tsx:829-845` — the reassurance that is currently lost on Continue.
- `packages/app/src/hooks/useLocalBackupSweep.ts` — live-backup recovery enqueue path.
- `apps/mobile/components/UploadProgressCard.tsx` — existing visual/presentational vocabulary to reuse.

### Constraints and Existing Patterns

- Legend State for all reactive state (`observable`, persisted via MMKV `syncObservable`) — the banner must be a derived observable, not React state polling.
- Theme colors come from `useAppThemeColors`; the app uses Tamagui tokens (`$primary`, `$error`, `$success`, `$placeholderColor`).
- `uploadQueueStore$` is keyed by task `id`, not user; user switching is handled by `uploadOwner` in the segment path — the banner must not show another account's jobs.
- `uiStore$.isOnline` exists but **has no writer** (`uiActions.setOnline` has zero callers). Do not build the offline state on it without wiring a real source first.
- Two upload systems coexist during the Mux retirement (`docs/mux-retirement.md`); the banner must cover both or it will silently miss whichever build a given user runs.

### Risks

- **Toast collision.** `ToastContainer` is `position: absolute; top: 60; zIndex: 9999` (`packages/ui/src/Toast.tsx:131`). A banner at the same offset would overlap. Mitigation: banner sits in flow under the safe-area inset and, while visible, the toast container offset is driven by banner height via shared state.
- **Double-reporting.** The `live_backup` sweep already fires a one-time "Finishing an upload from an earlier recording" toast. Mitigation: the banner must be the persistent surface and the toast the transient one — dedupe by task id, and assert this in the scenario test.
- **Stale jobs.** `cleanupForRefresh` drops active tasks older than 10 minutes (`ACTIVE_TASK_STALE_MS`). A genuinely slow upload could therefore vanish from the banner while still on disk. Mitigation: decide explicitly whether the segment path (journal-derived, not TTL-pruned) becomes the source of truth for "is anything pending" — see Open Question #2.
- **Scope creep into resume-on-launch.** Wiring background fetch or fixing the legacy cold-launch resume touches native config and release risk. Keep it out of this plan.

---

## Implementation Decisions (2026-09-29)

- **Design:** concept A, "Ember Strip" — a full-width strip in flow under the status bar. It pushes screens down instead of covering headers. While it shows, `(main)` screens get a zero top safe-area inset. Screens that hardcode a top padding use `useHeaderTopPadding`, so they look unchanged when the strip is hidden.
- **Toasts** move below the strip, using its measured height (`uploadStatusStore$.bannerHeight`).
- **Offline** comes from `expo-network` through `useNetworkStatusSync`, the first writer of `uiStore$.isOnline`. No new native dependency.
- **Segment source:** `runSegmentUploads` reports per-job status to an observer as it goes. There is no second directory scan. A paused job stays paused until a later pass makes progress, so the strip doesn't flicker.
- **Legacy queue** only counts where it actually runs (non-segmented builds). Segmented builds never drain it, so leftover MMKV tasks would otherwise show as a ghost banner.
- **Legacy cold-launch resume gap (Open Question 5): folded in.** `useLegacyUploadResume` mounts the unused `useResumeUploads` in `LegacyRecordingMaintenance`. Without it the strip would say "uploading" for work that isn't running.
- **Tapping the strip** retries only in the paused and failed states. While an upload is healthy there's nothing to do, so there's no button. "Try again" re-queues failed legacy tasks with a fresh retry ladder.
- **Completed** adds a "View" action that opens the bondfire when its id is known, and dismisses the confirmation.
- **Swipe right to hide.** This hides the strip for the rest of the app session. It never stops or pauses the upload, and the next launch shows it again. The one exception is a failure *after* the hide: that upload can't finish without the user, so the strip comes back. Screen readers get the same thing as a "Hide" action.
- **Background completion (Open Question 3):** still foreground-only. The sheet copy doesn't promise otherwise.

## Open Questions

- [ ] **Copy and tone** — is "still uploading … we'll finish it in the background" the right framing for a user who may be watching for social proof? (David)
- [ ] **Source of truth for "pending"** — journal directory scan (authoritative, includes jobs the queue has pruned) or the persisted queue (cheap, has progress/stage)? Recommend: queue for display, journal for existence. (David + Forge)
- [ ] **Background completion** — should this plan also register `expo-background-fetch` so uploads can progress while the app is closed, or keep Phase 1 foreground-only and revisit? (David)
- [ ] **Where else should it appear** — Feed only, or all `(main)` screens? Recommend all main screens; confirm no conflict with the recording overlay. (David)
- [ ] **Should the legacy cold-launch resume gap be folded in** as a small Phase 1 add-on, or filed separately? (Forge)
