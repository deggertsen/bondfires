# Recording capture/transport foundation

## Contract

The creator's recording lifecycle and the Mux RTMP transport are separate:

- `captureStatus` describes durable camera/file capture.
- `transportStatus` describes best-effort RTMP delivery.
- `backgroundStatus` describes whether capture is foregrounded, continuing in
  an Android foreground service, or paused by iOS.
- A transport disconnect never directly changes `captureStatus` or the
  user-facing recording phase.
- Healthy Mux Live VOD remains the canonical asset. The whole local MP4 is a
  recovery source only when the live asset fails or is materially incomplete.

`EXPO_PUBLIC_LOCAL_BACKUP_RECORDING=1` is now explicit in the production EAS
profile. Before this change the policy defaulted to off because no production
profile value existed. Low/unknown disk still prevents arming the backup.

## Platform implementation

### iOS

`startCapture()` starts the mixer-attached `HKStreamRecorder` before the RTMP
connection. The recorder remains attached when the HaishinKit `Session` is
replaced during reconnect. If RTMP cannot connect, capture remains active and
the whole-file recovery path can save it.

iOS prepares a video-call Picture-in-Picture controller and its second
HaishinKit preview output only after the capture session reports multitasking
camera support. PiP starts at a real background transition, not transient
`inactive` states such as Control Center or call banners. Native PiP events are
routed through the publisher hook so capture/background state has one event
owner. When PiP is unavailable or ends in the background, the same logical
recording moves to `paused`, and the existing `AVCaptureSession` interruption
observers move it back to capture when the system releases camera/microphone
access. Device support and App Store acceptance remain release gates.

### Android

Once the user starts publishing while the app is visible, a camera/microphone
foreground service keeps the native pipeline alive across app switching. Its
persistent notification returns to Bondfires or stops and saves the recording.
Swiping the app from recents also stops and finalizes capture before releasing
the foreground service, so no headless camera/microphone owner remains.

`CaptureTransportEndpoint` extends StreamPack's documented `CombineEndpoint`
customization point. It starts `MediaMuxer` first, attaches RTMP later, and
closes/reopens only RTMP during reconnect while camera, microphone, MediaCodec,
and the local file remain alive. Reconnect re-registers the existing codec
configuration with the RTMP child so each new connection receives fresh AAC
and AVC sequence headers without changing the encoder-facing stream IDs.
Endpoint map access is serialized with frame writes, and only open sinks
receive stream registration, so RTMP-only sessions never touch an uninitialized
`MediaMuxer`. RTMP remains detached from frame routing throughout its network
and publish handshake; local capture therefore keeps receiving frames during a
slow reconnect, and the completed transport mapping becomes visible atomically.

Both native modules enforce the account recording-duration limit independently
of React Native timers. The limit and UI clock intentionally measure wall time
from capture start. On iOS hardware without background camera support, time
paused in the background still counts toward the session limit even though no
frames are captured during that interval. The UI clock derives from wall time
when JS resumes.
Mux-confirmed live sessions, plus pre-live sessions with confirmed durable
capture, are exempt from the five-minute heartbeat reaper. Mux enforces a
12-hour maximum continuous duration, and the server reaper retains a 15-minute
settlement window beyond that limit as its absolute backstop.

## Recovery selection

The existing launch sweep and `live_backup` upload queue remain authoritative.
Mux Live wins when it reaches `ready`. A local backup is retained while the
asset is live/processing and uploaded only for `errored` or
`awaiting_recovery`. If Mux never became active but native stop finalized a
non-empty local file, `endLiveStream` preserves the linked record as
`awaiting_recovery` and the client immediately enqueues the same deduplicated
`live_backup` task used by early-drop recovery. The creator sees recovery
completion instead of "Recording didn't start."

## Required physical-device validation

These checks cannot be proven by TypeScript/unit tests or simulators and are a
release gate for enabling the behavior beyond an internal cohort:

- [ ] iPhone: tap-to-first-local-frame latency and audio/video sync.
- [ ] iPhone: switch apps, return, and verify pause/resume keeps one logical
      recording without discarding pre-background footage.
- [ ] iPhone: phone call, Siri, camera/mic contention, lock screen, and PiP
      capability/policy spike.
- [ ] Android 12–16: switch apps for 5+ minutes and verify camera/mic + RTMP
      continue under the foreground-service notification.
- [ ] Android: notification Return and Stop & save actions.
- [ ] Android: force a slow or timed-out RTMP reconnect and verify the local
      backup has no capture gap while the transport handshake is pending.
- [ ] Both: airplane mode, Wi-Fi/cellular switching, reconnect-window expiry,
      and RTMP loss while local capture continues.
- [ ] Both: force-kill/relaunch recovery, low disk, disk full, thermal pressure,
      duration cap, and rapid stop/start.
- [ ] Both: confirm healthy Mux Live assets delete the backup and failed or
      materially incomplete assets enqueue exactly one recovery upload.

## Follow-up boundary

1. Add OS-assisted durable background transfer where feasible. The current
   MMKV queue resumes on relaunch but is not an OS background-upload contract.
2. Define duration/timestamp tolerances for "materially incomplete" live VODs.
3. Complete the physical-device matrix above before widening the rollout.
