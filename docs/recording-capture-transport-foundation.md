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

iOS does not declare unsupported camera background modes. A normal AppState
transition is non-terminal: the same logical recording moves to `paused`, and
the existing `AVCaptureSession` interruption observers move it back to capture
when the system releases camera/microphone access. PiP multitasking camera
capture is a follow-up physical-device/App Store policy spike.

### Android

Once the user starts publishing while the app is visible, a camera/microphone
foreground service keeps the native pipeline alive across app switching. Its
persistent notification returns to Bondfires or stops and saves the recording.

StreamPack 3.1.2 remains the constraint: `CombineEndpoint` owns RTMP and
`MediaMuxer` together, and dynamically attaching/detaching only RTMP is not a
supported API. Reconnect still rebuilds the combined pipeline and rolls the
previous MP4 leg aside. A true capture/transport split therefore needs a
StreamPack fork/replacement or an encoded-frame fanout; this PR does not invent
a fragment backend or claim that limitation is solved.

## Recovery selection

The existing launch sweep and `live_backup` upload queue remain authoritative.
Mux Live wins when it reaches `ready`. A local backup is retained while the
asset is live/processing and uploaded only for `errored` or
`awaiting_recovery`. If Mux never became active but native stop finalized a
non-empty local file, the creator sees recovery completion instead of
"Recording didn't start."

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
- [ ] Both: airplane mode, Wi-Fi/cellular switching, reconnect-window expiry,
      and RTMP loss while local capture continues.
- [ ] Both: force-kill/relaunch recovery, low disk, disk full, thermal pressure,
      duration cap, and rapid stop/start.
- [ ] Both: confirm healthy Mux Live assets delete the backup and failed or
      materially incomplete assets enqueue exactly one recovery upload.

## Follow-up boundary

1. Prototype an Android detachable RTMP sink/encoded-frame fanout. Replace or
   fork StreamPack only after that spike demonstrates clean MediaCodec and
   MediaMuxer ownership.
2. Add OS-assisted durable background transfer where feasible. The current
   MMKV queue resumes on relaunch but is not an OS background-upload contract.
3. Define duration/timestamp tolerances for "materially incomplete" live VODs.
4. Evaluate supported iOS multitasking camera/PiP APIs on real hardware and
   with App Store policy review before adding entitlements.
