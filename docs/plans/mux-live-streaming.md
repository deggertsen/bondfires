# Mux Live Streaming Conversion Plan

## Executive Summary

Bondfires today does a "drop-in" Mux integration: the phone records a complete MP4, then uploads it via a Mux Direct Upload URL after the user stops recording. Friends see the video only after Mux finishes processing the asset (multi-minute end-to-end). The product goal is the opposite: a viewer should be able to open a bondfire and watch the creator in near-real-time, like a one-way live broadcast. This plan converts the mobile recording flow to **Mux Live Streaming over RTMPS** with `latency_mode: "low"`, targeting roughly 5–15 seconds of glass-to-glass delay (well within the ≤30 s tolerance David confirmed). The mobile publisher is a **custom Expo Module** that wraps HaishinKit on iOS and StreamPack on Android, since the React Native ecosystem has no production-quality cross-platform RTMP publisher and Mux does not support WebRTC/WHIP ingest. Convex is extended to provision live streams, process `video.live_stream.*` webhooks, and stitch the post-recording VOD into the existing `bondfires` / `bondfireVideos` records, so existing playback and the responses model keep working.

### Decision log

- **WHIP / WebRTC ingest considered and rejected (2026-05-16).** Mux explicitly does not support direct WebRTC ingest to a Live Stream — only RTMP, RTMPS, and SRT. See [Mux Live Streaming FAQs](https://docs.mux.com/guides/live-streaming-faqs).
- **Latency tolerance confirmed at ≤30 s.** Frees us to use `latency_mode: "low"` (~5 s target) with comfortable margin and stop chasing sub-second delivery.
- **RTMPS chosen over SRT.** Both are supported. RTMPS has broader library coverage; HaishinKit and StreamPack both support both protocols, so SRT remains a v2 lever if we ever need it.

### Live → VOD transition (important clarification)

Live publishing only matters *while the creator is recording*. The moment the creator stops, Mux finalizes the captured stream into an ordinary VOD asset and emits `video.asset.ready`. From that point on, viewers play a regular HLS file — there is no ongoing RTMP session, no low-latency tuning required, and no extra cost beyond standard VOD playback. The viewer's player simply transitions from a live (infinite-duration) HLS manifest to a finite VOD manifest, the scrubber re-enables, and the bondfire detail screen behaves exactly like every other recorded bondfire in the app. Late viewers — anyone who opens the bondfire after recording ends — never use the live path at all; they get a normal VOD playback URL from the Mux recorded asset. The "live" code path is narrow and self-contained: it exists only between `video.live_stream.active` and `video.asset.ready`, and everything after `ready` is the system we already have.

## Current State

The repo already has a partial scaffold for live streaming, which suggests an earlier exploratory pass. Important specifics:

**Mobile recording (`apps/mobile/app/(main)/(tabs)/create.tsx`)**: Uses `expo-camera`'s `CameraView` with `mode="video"` and `cameraRef.current.recordAsync()` (line 421). On stop, `finalizeRecording` (around line 351) optionally calls `mergeVideoSegments` (when the user swapped front/back cameras mid-record) and then calls `startBackgroundUpload`. This is a finalize-then-upload flow — there is no live publish anywhere. The native segment merger lives at `apps/mobile/ios/Bondfires/VideoSegmentMerger.swift` + `apps/mobile/android/app/src/main/java/org/bondfires/VideoSegmentMergerModule.kt`, which is direct evidence the team has shipped a custom native module before — important precedent for the RTMP publisher module below.

**Background upload service (`packages/app/src/services/backgroundUpload.ts`)**: Drives the existing Mux Direct Upload flow. It calls Convex actions `createMuxDirectUpload` and `getMuxUploadStatus`, PUTs the file with `expo-file-system`'s `createUploadTask`, then polls Mux until `playbackId` is ready (lines 188–220). Persists state through `uploadQueue.store.ts` so uploads survive app restart.

**Upload queue (`packages/app/src/store/uploadQueue.store.ts`)**: Legend State `observable<UploadQueueState>` backed by MMKV. Models a `UploadTask` with `muxUpload` (uploadId, uploadUrl, recordId, recordType) and `processedVideo` metadata. None of this models a live publisher session — it's strictly file-upload-task shape.

**Video processing (`packages/app/src/utils/videoProcessing.ts`)**: Trivial. Just reads metadata via `react-native-compressor`'s `getVideoMetaData`. No transcoding, no compression — Mux is expected to do the heavy lifting. This is relevant because live streaming will produce a recorded asset on Mux's side that we don't need to upload at all.

**Convex Mux actions (`convex/videos.ts`)**: Implements:
- `createMuxDirectUpload` (line 322) — for the existing finalize-then-upload flow.
- `getMuxUploadStatus` (line 399) — polled by the mobile uploader.
- `createMuxLiveSession` (line 471) — **already exists**, hits `POST /video/v1/live-streams` and returns `liveStreamId`, `streamKey`, `playbackId`, plus the hard-coded RTMP endpoint `rtmp://global-live.mux.com:5222/app` (line 25). It is not called from anywhere in the mobile app yet. Note: the hard-coded endpoint uses bare `rtmp://` on port 5222; we should change it to `rtmps://global-live.mux.com/app` (port 443) for transport encryption.
- `createMuxLiveSessionRecord` (line 778) — internal mutation that inserts into a `liveSessions` table.
- `handleMuxWebhookEvent` (line 797) — already branches on `video.live_stream.active`, `.idle`, `.errored` (lines 862–899) and updates the `liveSessions` row.

**Convex schema (`convex/schema.ts`)**:
- `bondfires` (line 36) and `bondfireVideos` (line 87) both already have `muxLiveStreamId` and `muxLivePlaybackId` optional fields (lines 57–58 and 112–113), but no code reads or writes them. The fields are unused dead weight today.
- `liveSessions` table (line 135) is fully defined with `status: 'created' | 'starting' | 'live' | 'ending' | 'ended' | 'errored'`, `muxLiveStreamId`, `muxLivePlaybackId`, `muxActiveAssetId`, `muxRecentAssetId`, indexes on user, live-stream-id (`by_mux_live_stream` at line 158), and status. There is no link from a `liveSession` to a `bondfire` or `bondfireVideo` actually used — only `bondfireId` and `bondfireVideoId` optional refs that nothing writes.
- `muxWebhookEvents` (line 161) provides idempotency.

**Convex HTTP (`convex/http.ts`)**: `/mux/webhook` route is fully wired (line 75) with HMAC-SHA256 signature verification using `MUX_WEBHOOK_SECRET`. It calls `internal.videos.handleMuxWebhookEvent`. This is solid; no changes needed.

**Mobile playback (`apps/mobile/app/(main)/bondfire/[id].tsx`)**: Uses `expo-video`'s `useVideoPlayer` + `VideoView` (lines 120, 327) pointed at `https://stream.mux.com/{playbackId}.m3u8` (returned by `getVideoUrls`). No low-latency HLS configuration. No awareness of "is live" — playback assumes a static VOD.

**Feed (`apps/mobile/app/(main)/(tabs)/feed.tsx`)**: Calls `api.bondfires.listFeed`, which filters out anything that isn't `videoStatus === 'ready'` and missing `muxPlaybackId` (`convex/bondfires.ts` line 22). This means currently-live bondfires would be invisible in the feed — a hard blocker for the new UX.

**What's "drop-in" vs missing**:
- *Drop-in today*: record → file → upload → poll until Mux ready → mark `videoStatus: 'ready'` → feed shows it. This is just Mux as a CDN.
- *Already half-built*: a `createMuxLiveSession` action and `liveSessions` schema/webhook handling, but no mobile caller, no association between a live session and the bondfire/response it belongs to, and no publisher on the device.
- *Missing entirely*: a device-side RTMPS publisher, feed visibility for live bondfires, low-latency HLS playback, viewer notification when a friend goes live, lifecycle handling for disconnects, and the bridge from `liveSession` → the eventual recorded asset that becomes the persistent bondfire.

## Target Architecture

```
┌──────────────────────────┐                  ┌───────────────────────────┐
│  Recorder (mobile)       │                  │  Viewer (mobile)          │
│                          │                  │                           │
│  BondfireLivePublisher   │                  │  expo-video VideoView     │
│  (custom Expo Module)    │                  │        (HLS LL)           │
│   ├─ HaishinKit (iOS)   │                  │                           │
│   └─ StreamPack (Android)│                  │                           │
└──────────┬───────────────┘                  └───────────────▲───────────┘
           │ RTMPS                                            │ HLS
           │ rtmps://global-live.mux.com/app                  │ stream.mux.com/{playbackId}.m3u8
           │ + streamKey                                      │ (LL-HLS while live, VOD after)
           ▼                                                  │
   ┌──────────────────────────────────────────────────────────┴────────┐
   │                              Mux                                  │
   │  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
   │  │ RTMPS ingest    │─▶│ Live transcode   │─▶│ HLS edge (LL)    │  │
   │  └─────────────────┘  └─────────┬────────┘  └──────────────────┘  │
   │                                  ▼                                │
   │                       ┌──────────────────┐                        │
   │                       │ Recorded VOD     │                        │
   │                       │ asset (after end)│                        │
   │                       └─────────┬────────┘                        │
   └─────────────────────────────────┼─────────────────────────────────┘
                                     │ webhooks
                                     ▼
                  ┌──────────────────────────────────┐
                  │  Convex                          │
                  │                                  │
                  │  POST /video/v1/live-streams     │
                  │     (createLiveStream action)    │
                  │  /mux/webhook (httpAction)       │
                  │  handleMuxWebhookEvent           │
                  │                                  │
                  │  Tables:                         │
                  │   liveSessions ──┐               │
                  │   bondfires ◀────┤ links via     │
                  │   bondfireVideos ◀┘ liveSession  │
                  └──────────────────┬───────────────┘
                                     │ Convex realtime subscriptions
                                     ▼
                          (Viewer client gets isLive=true,
                           playbackId, immediately renders HLS)
```

End-to-end flow:

1. Creator taps record. Mobile calls `createLiveStream` action. Convex creates a Mux live stream with `latency_mode: "low"` and recording enabled, inserts a `liveSessions` row, and creates a placeholder `bondfires` (or `bondfireVideos` if responding) row with `videoStatus: 'live'` and the live playback ID populated.
2. Convex returns `{ rtmpsUrl, streamKey, playbackId, ... }`. Mobile hands `rtmpsUrl` + `streamKey` to the `BondfireLivePublisher` native view, which starts capturing camera + mic and publishing the RTMPS stream.
3. Mux `video.live_stream.active` webhook fires once ingest stabilizes. Convex flips the `liveSessions` row to `live` and the linked `bondfires` row to `videoStatus: 'live'`. Convex's reactive queries push that to viewer clients in `feed.tsx`, which then render a "Live" badge.
4. Viewers tap and `bondfire/[id].tsx` plays the HLS playback URL while the creator is still publishing (~5–15 s behind).
5. Creator stops. Mobile tells the native module to stop, which closes the RTMPS connection. `video.live_stream.idle` arrives. Convex marks the `liveSessions` row `ended`. Mux's recording is created as a regular `video.asset.ready` (the asset's `live_stream_id` ties it back to the live stream).
6. Webhook handler associates the new asset (and its playback ID) with the original `bondfires` row, sets `videoStatus: 'ready'`, and the row now behaves like any pre-existing VOD bondfire. **From this moment on, all viewers — current and future — use ordinary VOD playback. No live-specific code paths.**

## Mux Capability Choice

Mux's supported live ingest protocols are RTMP, RTMPS, and SRT. Per [Mux's reduce-latency guide](https://docs.mux.com/guides/video/reduce-live-stream-latency), the available `latency_mode` values are:

| Mode | Glass-to-glass | Notes |
|---|---|---|
| standard (default) | 25–30 s | DVR-style live, most reliable |
| `reduced` | 12–20 s | Tighter chunks, slightly less buffer headroom |
| `low` | ~5 s | LL-HLS chunked transfer, requires stable upstream bandwidth |

**Choice: RTMPS to `rtmps://global-live.mux.com/app` with `latency_mode: "low"`.** Rationale:

- David's ceiling is 30 s, and `latency_mode: "low"` targets 5 s. That gives huge margin: even if a viewer is on a poor connection and falls into the 12–20 s range, we are still well under the tolerance.
- RTMPS adds TLS at no real cost; the stream key is sensitive and we should not send it in cleartext. The existing hard-coded `rtmp://global-live.mux.com:5222/app` in `convex/videos.ts:25` should change to `rtmps://global-live.mux.com/app`.
- RTMPS over SRT: both work and both are supported by HaishinKit and StreamPack. RTMPS has broader library tooling and is the protocol Mux's own React Native guide endorses. SRT's "Haivision-style" reliability advantages matter most for satellite uplinks and contribution-grade workflows; for consumer mobile we don't need it. Keep SRT as a v2 lever if we ever see flapping on cellular.
- Custom Expo Module is the right vehicle. The React Native RTMP library options are:
  - `react-native-nodemediaclient` — Mux's own React Native blog post uses it. Unmaintained at the React Native New Arch level, which we have enabled (`apps/mobile/app.json:10 "newArchEnabled": true`).
  - `react-native-haishin-kit` — iOS only.
  - Custom module wrapping HaishinKit (iOS) + StreamPack (Android). The team has already shipped one custom native module (`VideoSegmentMerger`) on both platforms, so the precedent and skill set exist in-house.

We pick the custom module. The two underlying libraries are healthy and modern:

- **HaishinKit.swift** ([github.com/HaishinKit/HaishinKit.swift](https://github.com/HaishinKit/HaishinKit.swift)) — RTMP/SRT for iOS, 10+ years of history, v2.2.5 about a month old as of 2026-05-16, native preview view (`MTHKView`), camera/mic capture pipeline, dynamic camera swap.
- **StreamPack** ([github.com/ThibaultBee/StreamPack](https://github.com/ThibaultBee/StreamPack)) — RTMP/RTMPS/SRT for Android, v3.1.0, modular Maven packages (`streampack-core`, `streampack-rtmp`, `streampack-srt`, etc.), built-in preview view, supports dynamic input source swap at runtime.

Both libraries already encapsulate camera + mic capture, H.264/AAC encoding, muxing, and network publish. The Expo Module's job is just to expose a small JS API and a native view component that hosts the library's preview surface.

## Convex Backend Work

### Schema additions

Most fields exist. Add the following to `convex/schema.ts`:

- `bondfires` (and `bondfireVideos`):
  - Extend the `videoStatus` union to include `v.literal('live')` (was only `'waiting_for_upload' | 'processing' | 'ready' | 'errored'`).
  - `liveSessionId: v.optional(v.id('liveSessions'))` — back-link so a webhook can resolve the bondfire from a live stream.
  - Index: `.index('by_live_stream', ['muxLiveStreamId'])` so the webhook handler can find the bondfire directly without going through `liveSessions` (the `liveSessions` table already has `by_mux_live_stream` at line 158).

- `liveSessions`:
  - Already has `bondfireId` and `bondfireVideoId` optional. Make sure these are populated when the live stream is created.
  - Add `transport: v.union(v.literal('rtmps'), v.literal('srt'))` for telemetry, defaulting to `'rtmps'`.
  - Add `latencyMode: v.optional(v.union(v.literal('standard'), v.literal('reduced'), v.literal('low')))`.
  - `muxRecordedAssetId: v.optional(v.string())` to record which VOD asset Mux produced.

### New / changed actions in `convex/videos.ts`

- **Rename/refactor `createMuxLiveSession` → `createLiveStream`** with required args:
  - `isResponse: v.boolean()`, `bondfireId: v.optional(v.id('bondfires'))`, plus optional `tags`, `width`, `height`.
  - Internally: call Mux `POST /video/v1/live-streams` with `latency_mode: "low"`, `new_asset_settings.playback_policies`, `reconnect_window` (e.g., 30 s — see Lifecycle), `simulcast_targets: []`, and `playback_policies: ["public"]` for v1.
  - Insert the `liveSessions` row and *also* insert the placeholder `bondfires` or `bondfireVideos` row with `videoStatus: 'live'`, `muxLivePlaybackId`, `muxLiveStreamId`, `liveSessionId`. Link them both directions.
  - Update the hard-coded ingest URL constant from `rtmp://global-live.mux.com:5222/app` to `rtmps://global-live.mux.com/app`.
  - Return `{ liveStreamId, liveSessionId, playbackId, playbackUrl, ingest: { rtmpsUrl, streamKey }, recordId, recordType }`.

- **New `endLiveStream` action**:
  - Args: `liveSessionId`, plus optional `reason` for telemetry.
  - Patch the `liveSessions` row to `status: 'ending'`. We do *not* need to call Mux to end the stream — the device closing the RTMPS connection is what triggers `video.live_stream.idle`. As a hardening measure, optionally call `POST /video/v1/live-streams/:id/disable` after a grace window to kill zombie sessions [verify endpoint name].

- **New `cancelLiveStream` action** (creator decides not to publish before connecting):
  - Calls `POST /video/v1/live-streams/:id/delete` [verify exact path], marks the `liveSessions` row `ended` with `errorMessage: 'cancelled'`, deletes the placeholder `bondfires`/`bondfireVideos` row so it never shows up in the feed.

- **Extend `handleMuxWebhookEvent`** (existing in `convex/videos.ts:797`):
  - `video.live_stream.connected` [verify event name; Mux's history has been `.created` and `.connected`] → set `liveSessions.status = 'starting'`.
  - `video.live_stream.active` → already handled (line 878). Additionally patch the linked `bondfires` row to `videoStatus: 'live'`, `updatedAt: Date.now()` so the feed re-orders.
  - `video.live_stream.disconnected` → set `status = 'ending'` but **do not** mark the bondfire as ended yet; Mux may reconnect within the `reconnect_window`.
  - `video.live_stream.idle` → existing handler sets `status: 'ended'`. Additionally find the linked `bondfires` row; if the recorded asset hasn't arrived yet, set `videoStatus: 'processing'`.
  - `video.asset.ready` where `asset.live_stream_id` is set → copy the asset's `playbackId` and `assetId` into the bondfire, set `videoStatus: 'ready'`, set `durationMs` from the asset, increment user counts (currently in `markRecordReady` — refactor so it can be called from the live path without double-counting). **This is the moment the bondfire becomes an ordinary VOD; nothing live-specific persists.**
  - `video.live_stream.errored` → existing handler updates the session. Additionally mark the bondfire `videoStatus: 'errored'` only if the stream never went `active` (otherwise the partial recording is still valuable).

### Webhook secret + ingest URL configuration

`convex/http.ts` is already wired. The only addition is documenting in a new `docs/mux-setup.md` that the Convex environment needs `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `MUX_WEBHOOK_SECRET`, and optionally `MUX_LIVE_LATENCY_MODE` (default `low`). Update `apps/mobile/.env.example` accordingly.

### Feed/query changes (`convex/bondfires.ts`)

`listFeed` (line 6) filters to `videoStatus === 'ready'` and a non-null `muxPlaybackId`. Loosen this to allow `videoStatus === 'live'` *and* `muxLivePlaybackId !== undefined`. Then in the row the feed renders, expose an `isLive` flag and a `livePlaybackId`. Similarly relax `getWithVideos` (line 36) so a live bondfire can be opened immediately.

## Mobile Recording Changes

### The custom Expo Module — `BondfireLivePublisher`

This is the biggest piece of new work. The module sits under `apps/mobile/modules/bondfire-live-publisher/` (Expo's local-module convention) and exposes both a JS API and a native view.

**Public TypeScript surface:**

```ts
// modules/bondfire-live-publisher/index.ts
export interface LivePublisherStartOptions {
  rtmpsUrl: string                    // e.g. rtmps://global-live.mux.com/app
  streamKey: string
  width?: number                      // default 720
  height?: number                     // default 1280  (portrait)
  fps?: number                        // default 30
  videoBitrate?: number               // bps, default 2_500_000
  audioBitrate?: number               // bps, default 128_000
  initialCamera?: 'front' | 'back'    // default 'back'
}

export interface LivePublisherView extends ViewProps {
  // hosts the camera preview surface from HaishinKit/StreamPack
}

export const BondfireLivePublisher: {
  start(options: LivePublisherStartOptions): Promise<void>
  stop(): Promise<void>
  swapCamera(): Promise<void>
  setMuted(muted: boolean): Promise<void>
  getStats(): Promise<{ bitrateBps: number; rttMs: number; droppedFrames: number }>
  // events
  addListener(event: 'statusChange', cb: (s: 'idle'|'connecting'|'live'|'reconnecting'|'errored'|'ended') => void): EventSubscription
  addListener(event: 'error', cb: (e: { code: string; message: string }) => void): EventSubscription
}

export const LivePublisherView: ComponentType<LivePublisherView>
```

**iOS implementation (`ios/`):**
- Swift sources in `modules/bondfire-live-publisher/ios/`.
- Depends on `HaishinKit` via CocoaPods (`pod 'HaishinKit', '~> 2.2'`).
- `LivePublisherView` wraps `MTHKView` (HaishinKit's `MTKView` subclass for the preview surface) and owns a `RTMPStream` + `RTMPConnection`.
- `start()` configures `MediaMixer`, attaches `AVCaptureDevice` for camera + `AVCaptureDevice` for audio, sets video/audio settings, opens the RTMP connection to `rtmpsUrl`, then publishes with `streamKey`.
- `swapCamera()` calls `mixer.attachVideo(...)` with the opposite camera position.
- Emits status changes via Expo Module's event emitter.

**Android implementation (`android/`):**
- Kotlin sources in `modules/bondfire-live-publisher/android/`.
- Depends on `io.github.thibaultbee.streampack:streampack-core` and `:streampack-rtmp` via Gradle.
- `LivePublisherView` hosts StreamPack's `PreviewView` and owns a `DefaultStreamer`.
- `start()` builds a `RtmpMediaDescriptor("rtmps", host, 443, "app", streamKey)`, configures `VideoConfig`/`AudioConfig`, connects, and starts streaming.
- `swapCamera()` calls `streamer.setInputSource(CameraSource(...))` with the opposite lens.

**Both platforms** must emit the same JS-visible status events so the React layer can be transport-agnostic.

### New library dependencies

In `apps/mobile/package.json`: no new RN packages. The Expo Module is local to the app. iOS pulls HaishinKit via CocoaPods (declared in the module's `*.podspec`); Android pulls StreamPack via Gradle (declared in the module's `build.gradle`).

### Expo / EAS work

- Module is autolinked because it lives under `apps/mobile/modules/`.
- iOS deployment target: HaishinKit requires iOS 13+; current app target is 15.1, so no change.
- Android: StreamPack requires `minSdk` 24+; verify against current setting.
- Force a fresh EAS dev build — this cannot run in Expo Go.
- Permissions: camera, microphone, and `INTERNET` are already declared (`apps/mobile/app.json` lines 22, 23, 41–48). No new permissions needed. Background streaming is out of scope for v1; if the app backgrounds, we stop.

### New files (app + shared)

- `apps/mobile/modules/bondfire-live-publisher/` — the Expo Module described above. Contains `expo-module.config.json`, `package.json`, `*.podspec`, `build.gradle`, `index.ts`, and the iOS / Android sources.
- `packages/app/src/store/livePublish.store.ts` — Legend State global store for the active publish session:
  ```ts
  export interface LivePublishState {
    sessionId: string | null               // Convex liveSessions ID
    bondfireId: string | null              // placeholder bondfire/bondfireVideo ID
    liveStreamId: string | null
    playbackId: string | null
    status: 'idle' | 'creating' | 'connecting' | 'live' | 'reconnecting' | 'stopping' | 'ended' | 'errored'
    startedAt: number | null
    bitrateBps: number
    droppedFrames: number
    networkQuality: 'good' | 'fair' | 'poor' | 'unknown'
    errorMessage: string | null
  }
  export const livePublishStore$ = observable<LivePublishState>({...})
  ```
  Not persisted (a crashed live session is dead). Provides actions: `start()`, `markLive()`, `stop()`, `fail(err)`, `reset()`.
- `packages/app/src/hooks/useLivePublisher.ts` — encapsulates the publish lifecycle. Returns:
  ```ts
  {
    start: (opts: { respondToBondfireId?: string }) => Promise<void>
    stop: () => Promise<void>
    cancel: () => Promise<void>
    swapCamera: () => Promise<void>
    stats$: Observable<{ bitrate: number; rtt: number; droppedFrames: number }>
  }
  ```
  Internally:
  1. Call Convex `createLiveStream` action; receive `{ rtmpsUrl, streamKey, playbackId, liveSessionId, recordId }`.
  2. Update `livePublishStore$` to `connecting`.
  3. `await BondfireLivePublisher.start({ rtmpsUrl, streamKey, ... })`.
  4. Subscribe to `statusChange` and `error` events; mirror into `livePublishStore$`.
  5. Sample `getStats()` every 5 s; classify `networkQuality` from bitrate and droppedFrames.
  6. On stop: `BondfireLivePublisher.stop()`, then `endLiveStream` Convex action.

### Files to change

- `apps/mobile/app/(main)/(tabs)/create.tsx` — substantial rewrite (behind feature flag in v1):
  - Remove `cameraRef`, `CameraView`, `startSegmentRecording`, `finalizeRecording`, `queueBackgroundUpload`, `mergeVideoSegments`, and the upload-queue plumbing from the live path. (Keep them reachable behind the off branch of the feature flag.)
  - Replace the recording state machine with `livePublishStore$` states.
  - Render `LivePublisherView` (from the new Expo Module) instead of `CameraView`. Reuse the existing record-button UI; "tap to record" calls `useLivePublisher().start()` instead of `startRecording`, "tap to stop" calls `stop()`.
  - Front/back camera swap previously merged segments. Now: call `swapCamera()` — both HaishinKit and StreamPack support hot-swapping the camera input on a running session, so viewers see a brief freeze but no reconnect.
  - On successful stop, show "Your live moment is being saved" and navigate to the bondfire detail screen.

- `packages/app/src/services/backgroundUpload.ts` — *unchanged for v1* but no longer invoked from the create screen. Keep it for the legacy/fallback path; remove in a later cleanup.
- `packages/app/src/utils/videoProcessing.ts` — unused in the live path. Leave as-is.

## Mobile Playback Changes

### Live playback (only while `videoStatus === 'live'`)

- `apps/mobile/app/(main)/bondfire/[id].tsx`:
  - The `getVideoUrls` action returns `https://stream.mux.com/{playbackId}.m3u8`. That URL works for both live and VOD. Source the playback ID from `muxLivePlaybackId` when the bondfire is live, falling back to `muxPlaybackId` once the recorded asset arrives. Both will typically be equal for replays of recorded live streams [verify Mux behaviour].
  - Low-latency HLS: `expo-video` will pick this up automatically if Mux serves LL-HLS, but the player needs a small live-stream override:
    - When `bondfireData.videoStatus === 'live'`, set the player's preferred forward buffer to a low value (the `expo-video` API exposes `bufferOptions` — [verify exact field name in v3]).
    - Disable the seek scrubber for live (the existing `progress * duration` math will misbehave on a live HLS manifest where `duration === Infinity`).
    - Show a "LIVE" badge instead of the time counter.
  - When the bondfire transitions from `live` → `ready` (Convex pushes a new snapshot via the live query), keep the same player but accept that the manifest will switch from live LL-HLS to a finite VOD manifest; seek can be re-enabled at that point.

### VOD playback after recording ends

Once `videoStatus === 'ready'`, the player behaves identically to every existing recorded bondfire. There is no special code path: ordinary HLS VOD over the same `stream.mux.com/{playbackId}.m3u8` URL, full scrubber, real duration, no LL-HLS tuning. A user who opens the bondfire an hour later — or a year later — never executes any live code. This is why the live conversion's surface area is small: it bolts onto the front of an already-working VOD pipeline.

### Feed (`apps/mobile/app/(main)/(tabs)/feed.tsx`)

- Render a pulsing "LIVE" pip on rows where `bondfire.videoStatus === 'live'`.
- Sort live bondfires to the top by reusing the existing `ModePill` mode `'active'`. Optionally add a new `'live'` pill (and a Convex query `listLive`).
- When the user taps a live row, the existing navigation already works because we changed `listFeed` to include `'live'` rows.

### Notifications

When a live stream goes `active`, send a push to the creator's followers/contacts via the existing `sendNotification` Convex module (used today for `notifyBondfireResponse`). Add `notifyBondfireLive` with title "X is live right now" and a deep link to the bondfire.

## State Management Changes

Following CLAUDE.md conventions:

1. **New global store** `packages/app/src/store/livePublish.store.ts`. `$` suffix, MMKV *not* used (live state should not survive restart; on app restart we call `endLiveStream` on any orphan session via a startup hook in `_layout.tsx`).

2. **`useLivePublisher` hook** uses `useObservable` for transient local state plus reads/writes the global store. Subscribing to `BondfireLivePublisher.addListener` for status / error events uses `useEffect` per CLAUDE.md rule 5 ("Keep `useEffect` for external library event listeners that need cleanup"). Periodic `getStats` sampling uses `useObserveEffect` (mutation/side effect in effect phase).

3. **`useWhenReady`** patterns:
   - `useWhenReady(() => livePublishStore$.status.get() === 'live', () => navigate-to-bondfire)` — once Mux confirms the stream is active, optionally deep-link the creator into their own bondfire detail page so they can see how viewers see them.

4. **`liveSessions` reactive query** in `bondfire/[id].tsx`: a new `api.liveSessions.getByBondfireId` query lets the viewer see live status transitions directly without polling.

5. **Upload queue store stays**: the existing `uploadQueue.store.ts` keeps working for any remaining legacy upload path during rollout, but is no longer touched by the create screen.

## Lifecycle and Edge Cases

- **Backgrounding mid-stream**: when `AppState` flips to `inactive`/`background`, call `BondfireLivePublisher.stop()` and `endLiveStream`. We do *not* try to keep streaming in background — that would require `audio` background mode entitlement and is a different product. The existing keep-awake logic in `create.tsx` (lines 150–168) already prevents the screen from sleeping while recording; reuse it.

- **Network drop**: RTMP is TCP. When the socket dies, HaishinKit and StreamPack both surface an error event without auto-reconnect (their reconnection helpers are basic and behave differently across libraries). For v1:
  - If `statusChange` reports `errored` within the first ~5 s of streaming → tear down, show "Couldn't connect — try again." Most likely a bad network on start.
  - If the error fires *after* `live`, set `livePublishStore$.status = 'reconnecting'` and try once more in-place. If that fails, surface "Connection lost — your video has been saved up to this point" and rely on Mux's `reconnect_window` to keep the recorded asset open for the partial.
  - Mux's `reconnect_window` (set to 30 s on `createLiveStream`) keeps the same playback ID, so the device reconnect re-uses the same `streamKey` and viewers don't see a new stream.

- **App crash**: a crashed publisher leaves a `liveSessions` row stuck in `live`. Mitigations:
  - On app foreground, query `api.liveSessions.listMyActive` and proactively call `cancelLiveStream` for anything older than ~60 s with no recent webhook activity.
  - Server-side cron (`convex/crons.ts`) scans for `liveSessions` in `live`/`starting` with `updatedAt` older than 5 minutes and calls Mux's disable endpoint.

- **Recording-while-streaming**: Mux records by default when `new_asset_settings` is included on the live stream. The recorded VOD becomes a regular asset with `live_stream_id` set, surfaced via `video.asset.created` and `video.asset.ready` webhooks. `handleMuxWebhookEvent` detects this by checking for a non-null `live_stream_id` on the asset payload, finding the bondfire via the new `by_live_stream` index, and patching `muxAssetId` / `muxPlaybackId` / `videoStatus: 'ready'`.

- **Viewer joining late**: HLS LL-HLS plays from the live edge by default. Late joiners during the stream see the present moment (delayed by the latency budget). After the stream ends, the recorded asset's playback URL serves the full replay. Viewers who open the bondfire for the first time *after* recording ends never touch the live path — they get a VOD URL and a finite manifest from the moment the screen mounts.

- **Multiple viewers**: Mux handles scale; nothing to do on the device.

- **Creator joining their own bondfire as viewer**: prevent the creator from playing their own live stream on the same device (the camera is already in use and any audio loopback would be terrible). Add a guard in `bondfire/[id].tsx`: `bondfireData.userId === appStore$.userId && bondfireData.videoStatus === 'live'` → render a "You are live" placeholder instead of the player.

## Migration and Rollout

- **Feature flag**: add a `livePublishEnabled` boolean to `appStore$.preferences` (default `false` for store release, `true` for dev/staging). The create screen branches: flag on → live publish; flag off → today's record-then-upload. This avoids forcing every existing user onto a brand-new flow before we're sure RTMPS publishing behaves on real networks.

- **Existing bondfires keep working**: rows with `videoStatus: 'ready'` and a `muxPlaybackId` are untouched. The feed query change only *widens* the filter to also include `'live'`.

- **Dev/staging Mux separation**: Convex's dev and prod deployments already have separate env vars; dev/staging point at a staging Mux env, prod points at prod Mux. Mux's webhook secret is per-environment; document both in `docs/mux-setup.md`.

- **Backout**: if RTMPS misbehaves in the field, flip the feature flag off; the old upload flow is still wired. As long as we don't delete `backgroundUpload` and friends in the same release, rollback is one preference toggle.

## Step-by-step Task Breakdown

Each step is sized so it can ship as its own PR. **S** ≈ half a day, **M** ≈ 1–2 days, **L** ≈ 3+ days. Sequencing matters where noted.

1. **(S) Schema + webhook extension** — update `convex/schema.ts`: extend `videoStatus` union with `'live'`, add `liveSessionId` to `bondfires`/`bondfireVideos`, add `by_live_stream` index, add `transport` and `latencyMode` to `liveSessions`. Run `npx convex dev` and check generated types compile across the workspace.
2. **(M) Convex live actions** — refactor `createMuxLiveSession` → `createLiveStream` that (a) creates the Mux live stream with `latency_mode: "low"`, `reconnect_window`, recording enabled, (b) inserts a placeholder bondfire row, (c) inserts the liveSession row, (d) returns `{ rtmpsUrl, streamKey, playbackId, ... }`. Add `endLiveStream` and `cancelLiveStream`. Update `handleMuxWebhookEvent` for `video.live_stream.*` and `video.asset.ready` (with `live_stream_id`) to also patch the linked bondfire. Add unit tests for the webhook branches.
3. **(S) Feed query relaxation** — update `convex/bondfires.ts:listFeed` and `getWithVideos` to allow `videoStatus === 'live'`. Add an `isLive` boolean to the returned shape.
4. **(L) Build `BondfireLivePublisher` Expo Module — iOS** — scaffold the local module (`apps/mobile/modules/bondfire-live-publisher/`), add HaishinKit dependency, implement `start/stop/swapCamera/setMuted/getStats`, wire status & error events. Manual test: publish to a Mux test stream and confirm playback in the Mux dashboard.
5. **(L) `BondfireLivePublisher` Expo Module — Android** — same surface on Android using StreamPack. Match the JS event contract exactly so the upstream hook is platform-agnostic.
6. **(M) `livePublish.store.ts` + `useLivePublisher` hook** — wire `start()` to call the Convex action, then call the native module. Subscribe to module events and mirror into the store. Add jest tests with a mocked native module.
7. **(M) New create screen** — rewrite `apps/mobile/app/(main)/(tabs)/create.tsx` behind the `livePublishEnabled` flag. Render `LivePublisherView` instead of `CameraView`. Reuse the existing record-button UX. Camera swap via `swapCamera()`. Wire stop/cancel buttons.
8. **(S) Viewer live badge + LL-HLS tweaks** — update `apps/mobile/app/(main)/bondfire/[id].tsx` to render a LIVE pip when `videoStatus === 'live'`, hide the scrubber, configure `expo-video` for low buffer. Update `feed.tsx` to render a LIVE row badge.
9. **(S) Creator self-watch guard** — in `bondfire/[id].tsx`, when the current user owns a `'live'` bondfire, render a stub instead of the player.
10. **(S) Push notification on go-live** — extend `convex/sendNotification.ts` with `notifyBondfireLive` and call it from the webhook handler on `video.live_stream.active`. Use existing deviceTokens infra.
11. **(S) Orphan-session cleanup cron** — add a Convex cron job in `convex/crons.ts` (new file if absent) that disables Mux live streams whose `liveSessions` rows are `live` but stale (>5 min since `updatedAt`).
12. **(S) Documentation** — add `docs/mux-setup.md` describing required env vars, Mux dashboard webhook config, and how to test live ingest from the device. Update `apps/mobile/.env.example`.
13. **(M) Soak + observability** — sample publisher stats every 5 s into a lightweight Convex `liveSessionMetrics` table or just log to console for v1. Validate on cellular (LTE + 5G), poor wifi, foreground/background transitions, mid-stream camera swap, rapid stop/start.
14. **(M) Remove legacy upload code** — after RTMPS is the default for ~2 weeks, delete `backgroundUpload.ts`, `videoProcessing.ts`, `uploadQueue.store.ts`, the `mergeVideoSegments` native module, and the corresponding Convex actions `createMuxDirectUpload` / `getMuxUploadStatus`.

Critical path: 1 → 2 → 4 → 5 → 6 → 7 unblocks an end-to-end demo. iOS (4) and Android (5) can be parallelized if you have two people. 3 and 9 are required for the live UX. 10–12 are polish. 13–14 are stabilization.

## Open Questions / Decisions for David

- **Custom module placement**: keep the publisher under `apps/mobile/modules/bondfire-live-publisher/` (Expo's local-module convention) or split it into `packages/live-publisher/` for potential reuse? Recommend local-module for v1 to avoid premature packaging.
- **Encoding ceiling**: the plan defaults to 720p30 at 2.5 Mbps video + 128 kbps audio. Phones can do higher, but Mux's `low` latency mode is sensitive to upstream stability and 720p is plenty for the playback surface. Confirm or override.
- **Should the creator's own live stream count toward their `bondfireCount` immediately when it goes `live`, or only when the recording is `ready`?** Current code increments the count on `markRecordReady` (`convex/videos.ts:246`). The plan keeps that behaviour to avoid inflating counts for streams that error before producing a recording. Confirm preference.
- **Does the response model carry over unchanged?** Today a "response" is a separate row in `bondfireVideos`. The plan applies live streaming identically to responses (creating a `bondfireVideos` placeholder with `videoStatus: 'live'`). Confirm responses should also be live (rather than always recorded VODs).
- **Notification semantics**: should `notifyBondfireLive` notify all followers, only response participants, or only viewers who have explicitly subscribed? No precedent in the codebase today.
- **Cancellation UX**: if the creator backs out before connection succeeds (after `createLiveStream` returns but before `live`), do we leave a stub `bondfires` row with `videoStatus: 'errored'` or delete it? The plan says delete via `cancelLiveStream`. Confirm.
- **`viewedBondfires` interaction**: live bondfires should *not* be marked viewed on tap because that would inflate the "new" badge logic. The plan sets `markViewed` to only fire on `videoStatus === 'ready'`.

---

### Critical Files for Implementation

- /Volumes/Repos/bondfires/apps/mobile/app/(main)/(tabs)/create.tsx
- /Volumes/Repos/bondfires/convex/videos.ts
- /Volumes/Repos/bondfires/convex/schema.ts
- /Volumes/Repos/bondfires/apps/mobile/app/(main)/bondfire/[id].tsx
- /Volumes/Repos/bondfires/convex/http.ts
- /Volumes/Repos/bondfires/apps/mobile/modules/bondfire-live-publisher/ (new — the custom Expo Module)
