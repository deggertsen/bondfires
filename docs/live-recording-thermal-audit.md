# Live recording thermal audit

## Incident

The July 17 iOS session `1f2453b4-e678-4a33-a030-a005b17ff238` moved from
nominal to critical in about 9.5 minutes. The client logged the intended
quality ladder (2.5 Mbps/30 fps → 1.5 Mbps/24 fps → 800 Kbps/15 fps), but those
logs described requested values, not native encoder state.

## End-to-end finding

| Stage | Before this change | After this change |
| --- | --- | --- |
| `LiveRecordScreen` | Awaited the hook and logged requested values | Logs values acknowledged by native code and logs rejected updates |
| `useLivePublisher` | Optional-call to `publisher.setVideoQuality` | Required call with a typed native acknowledgement |
| Expo module wrapper | Did not declare or export `setVideoQuality` | Forwards the call to the Expo native module; a stale build rejects instead of silently succeeding |
| iOS | Native implementation existed, but returned before its nested task completed | Awaits the live HaishinKit/VideoToolbox update and reads bitrate/FPS back before resolving |
| Android | Native implementation changed MediaCodec bitrate but ignored FPS | Reads MediaCodec bitrate back and updates Camera2 FPS through the live `CameraSource` configuration path |

The missing Expo wrapper method was the immediate root cause: the production
JS call used optional chaining, so neither native implementation was invoked.

## Native verification

### iOS (HaishinKit 2.0.9)

`stream.setVideoSettings` changes `VideoCodecSettings.bitRate`. In HaishinKit
2.0.9, bitrate is deliberately excluded from the settings that invalidate the
compression session; the library applies it directly to the running
`VTCompressionSession`. `mixer.setFrameRate` updates the attached
`AVCaptureDevice` frame durations. The Expo promise now resolves only after
both actor calls finish and returns the settings read back from the stream and
mixer.

The encoder is H.264 Baseline 3.1 with frame reordering disabled. Level 3.1 is
appropriate for 720p30. VideoToolbox is the hardware-accelerated path on the
supported iOS devices.

### Android (StreamPack 3.1.2)

`videoEncoder.bitrate` is StreamPack's dynamic MediaCodec bitrate API; the
value is read back from the encoder after assignment. Replacing `VideoConfig`
would reconfigure the encoder mid-stream, so the thermal path avoids it and selects
the best supported Camera2 FPS range at or below the requested ceiling and
applies it to the active source's repeating capture request while the existing
MediaCodec remains alive. The acknowledgement reports `fpsApplied: false` if a
device exposes only a higher range.

## Other thermal load

The original pipeline could do full-HD encode-sized work:

- iOS derived the encode size from the camera's active sensor format and did
  not explicitly pin the capture preset.
- Android dropped the JS width/height options and selected the largest camera
  output up to 1920×1080.

Bitrate reduction alone does not reduce camera, scaling, preview, or per-frame
encoder work. 1080p contains 2.25 times as many pixels as 720p. This change
uses 720×1280 as the live default, requests the iOS 720p capture preset, caps
the iOS encode size, and makes Android honor the requested camera/encoder
ceiling.

The iOS preview is rendered by a Metal-backed `MTHKView`; Android also feeds a
preview surface through StreamPack. The HaishinKit mixer is in passthrough
mode, so there is no additional offscreen composition pass. Preview rendering,
camera ISP, H.264 encoding, audio capture, TLS, and Wi-Fi/cellular transmit are
all expected concurrent heat sources, but resolution and FPS dominate the
controllable per-frame work.

Existing periodic work is modest: stats every 5 seconds, the native iOS
connection check every 3 seconds, thermal state every 10 seconds, and the live
session heartbeat every 120 seconds. Increasing these intervals would save
little compared with reducing pixels and frames, and would weaken failure or
thermal response. The thermal check is now serialized so slow native updates
cannot overlap.

## Follow-up measurement

1. Run a 15-minute physical-device A/B test on the same iPhone model, initial
   battery level, network, brightness, and ambient temperature.
2. Confirm `live:thermal_mitigation` includes `appliedVideoBitrate`,
   `appliedFps`, and `fpsApplied`; any stale native build will instead emit
   `live:thermal_mitigation_failed`.
3. Capture an Xcode Energy Log/System Trace and compare Camera, GPU,
   VideoToolbox, CPU, and radio utilization at 720p30, 720p24, and 720p15.
4. If 720p30 still reaches serious quickly, start live sessions at 24 fps. If
   the preview remains a material GPU consumer, test hiding or lowering the
   preview refresh rate after recording begins while leaving capture active.
5. Consider emitting fair/serious thermal transitions from native observers
   to remove the current 0–10 second polling latency. The 10-second poll itself
   is not a meaningful heat source.
