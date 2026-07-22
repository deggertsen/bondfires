# Local Backup Recording (and the Path to Offline Recording)

**Author(s):** David + Claude
**Date:** 2026-07-22
**Status:** Draft
**Complexity:** Large (three independently shippable phases)

---

## Executive Summary

Today a live recording exists in exactly one place while it is being made: the in-flight RTMP stream. If the app crashes, the network hard-fails, or upload throughput collapses, the only surviving copy is whatever Mux already ingested — which in the worst cases is nothing (`video.asset.errored`: *"live stream disconnected before sufficient video data received"*, hit by 3 users in 3 days of July 2026 telemetry; one session streamed for 31 seconds while ABR collapsed 2.5M→600k and delivered almost no usable media).

This plan adds a **local MP4 backup recorded on-device in parallel with the RTMP stream**. When the live path succeeds, the file is deleted silently. When it fails — crash, expired reconnect window (see `docs/plans/mux-live-streaming.md` and PR #184), errored asset — the file survives and is uploaded through the existing upload queue to become the recording's asset. Phase 3 extends the same machinery to **fully offline recording**: no network, record to file, post when connectivity returns.

Both streaming libraries we already ship support this natively — no library swaps, no forks:

- **iOS — HaishinKit 2.0.9** (vendored): `HKStreamRecorder` is compatible with `MediaMixer` outputs — `mixer.addOutput(recorder)` writes an MP4 via AVAssetWriter **independent of any RTMP session**. It keeps recording through PR #184's session rebuilds and with zero network. (Verified in `ios/Pods/HaishinKit/HaishinKit/Sources/HKStream/HKStreamRecorder.swift`.)
- **Android — StreamPack 3.1.2**: `CombineEndpoint` fans a **single encode** out to multiple sinks; `MediaMuxerEndpoint` writes MP4. The streamer becomes `CombineEndpoint(RtmpEndpoint, MediaMuxerEndpoint)` with no double-encode cost. (Verified in the streampack-core 3.1.2 AAR.)
- **Upload machinery already exists**: the legacy record path's persisted MMKV upload queue (`uploadQueue.store.ts`), `backgroundUpload.ts` (Mux direct upload, retry/backoff, resume-on-launch) — the backup file becomes another producer for that queue.

### Relationship to PR #184 (in-place reconnect)

Reconnect is the first line of defense: it handles transient network switches with no gap in the asset beyond slate. Local backup is the safety net for everything reconnect cannot save: hard crashes, reconnect give-ups, ABR-collapsed uploads, and offline. They compose; neither replaces the other. `live:reconnect_giveup` telemetry after #184 ships tells us how much residual loss this plan addresses.

---

## Phase 1 — Silent backup during live recording

**Goal:** every live recording also lands as a local MP4; nothing else changes. Ship behind a feature flag. Even without recovery upload, this ends the era of unrecoverable loss (support can say "the footage is on your phone") and the telemetry proves the value.

### iOS

- Create an `HKStreamRecorder` in `LivePublisher.start()` and attach with `mixer.addOutput(recorder)`; `startRecording(url)` to a file under the app's Documents/`recordings/` named `<liveSessionId>.mp4`.
- Mixer attachment means a **second encode** (AVAssetWriter H.264/AAC) alongside the HaishinKit stream encoder. This must be measured on an older device against the existing thermal ladder (`THERMAL_QUALITY_LADDER`, native critical auto-stop). Mitigations if needed: record at a reduced backup bitrate/resolution, or fall back to `stream.addOutput(recorder)` (single encode) at the cost of losing backup coverage during session rebuilds.
- `stopRecording()` on stop/cancel; recorder lifecycle must survive PR #184's reconnect session detach (it does, by construction, when mixer-attached).

### Android

- Switch `SingleStreamer`'s endpoint to `CombineEndpoint(RtmpEndpointFactory, MediaMuxerEndpoint(file))`. One encoder, two sinks — no extra encode or thermal cost.
- **Prototype question #1 (do this first):** failure isolation. If the RTMP sink drops (network switch), does the CombineEndpoint keep writing the file sink, and vice versa? The whole design rests on the answer; if isolation is poor, fall back to a raw `MediaMuxer` tee fed from the encoded-frame path.
- Teardown discipline: `MediaMuxerEndpoint` adds another MediaCodec-adjacent teardown path — exactly the SIGSEGV class the existing `teardownLock` / release-only / 5s-timeout logic in `cleanupStreamer()` exists for. All new teardown goes through the same lock.

### Shared lifecycle & policy

- **Arm:** start the file when RTMP connect starts (record tap), not during preview.
- **Disk guard:** ~19 MB/min at 2.5 Mbps (≈60 MB for a typical 3-minute bondfire). Before arming: require e.g. 500 MB free (TestFlight feedback already reports `availableDiskBytes` — we have distribution data); hard-cap file size at the tier recording limit + margin; refuse to arm (stream-only, telemetry event) when constrained.
- **Cleanup:** delete the file when the server confirms the live asset (`videoStatus: 'ready'` for that `liveSessionId`), when the user cancels, or after a retention window (e.g. 7 days) as a backstop sweep on launch. Never delete on mere app relaunch.
- **Crash-safe container:** an MP4 that isn't finalized after a hard kill must remain playable. Use fragmented MP4 / `shouldOptimizeForNetworkUse` + `movieFragmentInterval` on AVAssetWriter; verify MediaMuxer behavior on Android (may need the fMP4 option of StreamPack's own MP4 muxer instead of platform MediaMuxer). **Prototype question #2:** kill -9 mid-recording on both platforms, confirm the file is salvageable.
- **Telemetry:** `backup:armed`, `backup:skipped` (reason: disk/flag), `backup:finalized` (size, durationMs), `backup:discarded` (reason: live asset ready / cancel / retention), `backup:write_failed`. Correlate `backup:finalized` against `video:webhook:asset_errored` to quantify saved footage.

**Estimate:** iOS a few days; Android ~a week including the CombineEndpoint prototype; plus EAS device testing on both.

---

## Phase 2 — Recovery upload

**Goal:** when the live asset fails, the backup file automatically becomes the recording.

### Client

- On terminal failure (`live:early_drop` cancel path *with a backup present*, reconnect give-up finalize where Mux later reports the asset errored, or next-launch crash recovery), enqueue the backup file into the existing upload queue with a new task type `live_backup` carrying `{ liveSessionId, recordId }`.
- Next-launch matching: files are named `<liveSessionId>.mp4`; on launch, for each orphaned file ask the server for that session's record state — asset `ready` → delete file; `errored`/`processing`-stuck → enqueue recovery upload. This composes with the crash-recovery sweep (which, since PR #183, finalizes rather than deletes progressed sessions).
- UX: silent when possible; a small "Recovering your recording…" state on the affected bondfire is acceptable.

### Server (Convex)

- New mutation/action `recoverLiveRecordWithUpload`: given `liveSessionId` + a completed direct-upload asset, attach the asset to the **same** `bondfires`/`bondfireVideos` record (reuse `markRecordReady` plumbing), only when the record's live asset is `errored` or terminally stuck.
- **Dedupe rule:** if both the live asset and the backup upload end up viable, the live asset wins and the backup asset is deleted (`deleteFailedBondfireMuxAssets` path). Never double-attach.
- Guard rails: the record must belong to the session's user; the recovery window is bounded (e.g. 7 days, matching client retention).
- Important interaction: `handleFailedBondfire` / `markLinkedLiveRecordErrored` currently delete never-watchable spark rows. With recovery possible, deletion should be deferred for records that may still receive a backup upload (e.g. mark `awaiting_recovery` with a give-up cron) — this is the subtlest server change in the plan.

**Estimate:** ~a week including the deferred-deletion rework and tests.

---

## Phase 3 — Offline recording

**Goal:** no network at the create screen → record locally anyway, post when back online. Mostly product work on top of Phases 1–2 plumbing.

- **Client flow:** when provisioning is impossible (offline), skip it; record straight to file via the Phase 1 recorder (no RTMP at all); on stop, enqueue an upload task that **creates** the bondfire at upload time (the legacy record path already proves create-from-upload server-side).
- **Product decisions needed:**
  - Camp selection offline requires a cached camp list (and stale-membership handling at upload time — the join may have been revoked).
  - Offline recordings are not live — no live viewers, no live notifications; notify on `ready` instead. Is that acceptable UX for a "live-first" product?
  - Messaging: "Saved on your phone — will post when you're back online", with a visible pending row (upload queue UI already exists on the legacy path).
  - Tier limits (duration caps) must be enforced client-side since the server isn't consulted at record time.
- **Server:** a `createBondfireFromUpload`-style path for camp/spark/response parity with live creation (participants, counters, notifications at `ready`).

**Estimate:** 2–3 weeks, dominated by product/UX decisions rather than plumbing.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| iOS second encode raises thermal load | Measure on old hardware first; reduced backup bitrate; existing thermal ladder + critical auto-stop already protects; worst case stream-attached recorder |
| Android MediaCodec/muxer teardown SIGSEGV class | All teardown through the existing `teardownLock` discipline; release-only; timeouts |
| CombineEndpoint failure isolation unknown | Prototype before committing (question #1) |
| Unfinalized MP4 after hard kill | Fragmented MP4 / fragment interval; kill-test both platforms (question #2) |
| Disk pressure on small devices | Free-space gate before arming; size cap; retention sweep; `backup:skipped` telemetry to size the problem |
| Double-posting (live asset + backup both succeed) | Server-side dedupe rule: live asset wins, backup asset deleted |
| Deferred deletion leaves zombie records | `awaiting_recovery` state with a give-up cron mirroring `STUCK_LIVE_RECORDING_GIVE_UP_MS` |

## Rollout

1. Feature flag (default off) → internal builds → TestFlight cohort → general.
2. Phase 1 ships alone and bakes; watch `backup:*` + thermal telemetry for a release cycle.
3. Phase 2 after `backup:finalized`-vs-`asset_errored` correlation confirms the files we keep are the ones we need.
4. Phase 3 scoped as its own product project once 1–2 are stable.

## Open questions

1. CombineEndpoint failure isolation (Android prototype).
2. Crash-salvageable MP4 verification (both platforms).
3. iOS dual-encode thermal cost on oldest supported hardware.
4. Product: offline recordings are not live — acceptable? Notification timing?
5. Backup quality: full 2.5 Mbps parity or a reduced (e.g. 1.5 Mbps) backup tier to halve disk/thermal cost?
