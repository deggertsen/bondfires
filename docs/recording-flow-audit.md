# Recording Flow Audit — June 12, 2026

Audit of the video recording/creation system prompted by two field reports: a camera freeze mid-recording, and a response that the bondfire metadata counted but the thread viewer couldn't reach. Both root causes were found and fixed in this pass; the second half of this doc proposes a cleaner architecture.

## Bug 1: Response counted but not swipeable

### Root cause

The response count and the swipe list come from two different sources that are allowed to disagree:

- **Count**: the denormalized `bondfire.videoCount` field (`BondfireRow.tsx:92` shows `videoCount - 1`).
- **Swipe list**: `getWithVideos` (`convex/bondfires.ts`) filtered by `isPlayableVideoRecord` — only `ready` + `muxPlaybackId` or `live` + `muxLivePlaybackId` rows.

A **live response is counted at provisioning** (`createMuxLiveStream`, `videos.ts` — `videoCount + 1` the moment the row is inserted with status `live`). When the stream dies (e.g. the camera freeze), the record is demoted to `processing` (`markLinkedLiveRecordProcessing`) and disappears from the swipe list while remaining in the count. Two outcomes:

1. **Transient**: Mux finishes the recorded asset → `asset.ready` webhook → `markRecordReady` → playable again. Window is minutes, but it looks broken the whole time (this is what happened this morning).
2. **Permanent**: the asset errors or the session is reaped (`markRecordErrored`, `markLinkedLiveRecordErrored`) — the row goes `errored` but **nothing decremented `videoCount`**, so the count is inflated forever.

### Fixes applied

- `convex/videos.ts` — new `reconcileErroredResponseCounts()`: when a counted response transitions to `errored` (webhook, stuck-record reconciliation, or stale-session reaper), `bondfire.videoCount` and `user.responseCount` are decremented. Idempotent (skips already-errored rows), and `cancelMuxLiveSessionRecord` now routes through the same helper, which also fixes a pre-existing double-decrement window (cancel retried after the reaper already errored the row).
- `convex/bondfires.ts` — `getWithVideos` now returns `processingResponses` (lightweight projection: id, user, name, createdAt) for rows that are counted but not yet playable.
- `bondfire/[id].tsx` — the header subtitle shows "1 response processing…" instead of "Swipe for responses" when in-flight responses exist, so the transient window is explained instead of looking like data loss.

### Recommended follow-ups

- **Repair existing data**: the fix is forward-only. A one-shot internal mutation (or cron) that recomputes `videoCount` per bondfire from actual non-errored rows would heal counts inflated before today.
- **Count at watchable, not at provisioning**: increment `videoCount` for live responses at `live_stream.active` (the same moment the response push fires) rather than at provisioning. This shrinks the count/list gap to only the post-stream processing window.

## Bug 2: Camera freeze mid-recording (iOS)

### Root cause

The iOS native module has **no health monitoring at all** after `connect()` succeeds, while Android monitors three signals. Comparison:

| Signal | Android (`BondfireLivePublisherModule.kt`) | iOS (`BondfireLivePublisherModule.swift`) |
|---|---|---|
| Internal encoder/camera errors | `throwableFlow` → `error` event | — |
| Stream stopped | `isStreamingFlow` → `stream_stopped_unexpectedly` | — |
| RTMP connection dropped | `isOpenFlow` → `endpoint_closed` | — |
| Capture interruption (call, thermal, app switch) | (covered by throwableFlow) | — |

On iOS, an RTMP drop, an `AVCaptureSession` interruption, or a runtime error froze the preview with the UI stuck on "● REC" — exactly the reported symptom. The JS layer (`create.tsx:1552`) already auto-finalizes the partial recording on `errored`/`stream_stopped_unexpectedly`/`endpoint_closed`, but iOS never emitted any of them.

`getStats()` also returns hard-coded zeros on both platforms, so the JS stats sampler can't detect frame stalls either.

### Fixes applied (`BondfireLivePublisherModule.swift`)

- **Connection monitor**: polls `Session.isConnected` every 3s while publishing (HaishinKit's Session API exposes no disconnect event); emits `endpoint_closed` on drop → JS auto-stops and saves the partial recording.
- **Capture observers**: `AVCaptureSession.wasInterruptedNotification` and `runtimeErrorNotification` now emit `error` events while publishing → JS finalizes instead of freezing. Preview-only interruptions are left alone (AVFoundation auto-resumes).
- **`isStopping` flag** mirroring Android's `isStoppingIntentionally` so intentional teardown can't masquerade as a failure.

### Remaining freeze risks (not fixed here)

- No frame-level watchdog: if the encoder stalls while the RTMP socket stays open, neither platform notices. Real `getStats()` (HaishinKit `currentFPS` / StreamPack bitrate) + a JS-side "no frames for N seconds" check would cover it.
- `swapCamera` failure leaves JS `facing` state flipped even when the native swap failed (`create.tsx` `toggleLiveFacing`).

## Architecture audit: why this system grows bugs

**1. Two complete recording pipelines live in one 2,468-line screen.** `create.tsx` contains both the live RTMP path (preview/provision/connect) and the legacy expo-camera segment path (recordAsync → merge → upload queue), with separate state, separate stop/cancel/swap logic, and separate failure handling. Most of the ref-juggling (`recordingSessionRef`, `recordingActionRef`, `hasActiveSegmentRef`, `isStartingRecordingRef`) exists to serialize the legacy path.

**2. Four+ sources of truth for "what is the recording doing":**
- `state$.recordingState` (component): `idle | pre_connected | recording | stopping | completion | processing | uploading`
- `livePublishStore$.status` (global): `idle | creating | ready | connecting | live | reconnecting | stopping | ended | errored` + raw native strings cast in (`useLivePublisher.ts:110` casts any unknown native status into the union)
- Native module state (capture running, session connected)
- Server `videoStatus`: `pending | waiting_for_upload | processing | live | ready | errored`

Effects watch combinations of the first two and can disagree (e.g. `recordingState === 'recording'` with `liveStatus === 'errored'` is a state only reachable through a specific event ordering).

**3. Denormalized counters with one-way maintenance.** `videoCount`, `responseCount`, `bondfireCount`, `camp.bondfireCount` are incremented on several paths and (before this fix) decremented on almost none. Any new status transition risks re-introducing drift.

## Redesign proposal

Ordered by leverage; each step is independently shippable.

1. **Single recording state machine.** Move all recording state into `livePublish.store.ts` as one explicit machine: `idle → preview → provisioned → connecting → recording → stopping → saved | failed`, with transitions only via store actions that validate the current state. `create.tsx` renders from one `useValue(machine$.state)`. Kills the recordingState×liveStatus matrix and the belt-and-suspenders status suppression in `useLivePublisher`.
2. **Split create.tsx** into `CampPickerScreen`, `LiveRecordScreen`, `LegacyRecordScreen`, and a `useRecordingMachine` hook. The render branches are already cleanly separable.
3. **Retire one pipeline.** If live-publish is the product direction (it gates on `isLivePublisherAvailable`, so legacy is effectively a simulator/fallback path), move the legacy path behind a thin fallback component and stop evolving it.
4. **Typed native event contract.** Define the status/error string unions once (shared TS file + matching Swift/Kotlin enums) instead of casting unknown strings into `LivePublishStatus`. Add the iOS/Android parity table above as a checklist in the module README.
5. **Server: status transitions in one place.** A single `transitionVideoStatus(record, to)` mutation helper that owns counter side-effects per transition (ready→ +1, errored-after-counted→ −1, delete→ −1). Webhooks, reapers, crons, and client cancels all call it. Today the same logic is spread across `markRecordReady`, `markRecordErrored`, `addResponse`, `cancelMuxLiveSessionRecord`, and `users.ts`.
6. **Real stats + frame watchdog** (both platforms) so a frozen encoder is detected within seconds and auto-finalized.
7. **Count repair cron** validating `videoCount` against rows, logging drift — drift then becomes a monitored invariant instead of a silent UX bug.

## Files changed in this pass

- `convex/videos.ts` — errored-response counter reconciliation (3 call sites)
- `convex/bondfires.ts` — `isProcessingVideoRecord`, `processingResponses` in `getWithVideos`
- `apps/mobile/app/(main)/bondfire/[id].tsx` — processing indicator in thread header
- `apps/mobile/modules/bondfire-live-publisher/ios/BondfireLivePublisherModule.swift` — connection monitor, capture interruption/runtime-error observers, `isStopping` guard
