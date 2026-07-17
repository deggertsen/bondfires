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
| iOS | Native implementation existed, but returned before its nested task completed | Awaits both HaishinKit configuration calls before resolving |
| Android | Native implementation changed MediaCodec bitrate but swallowed failures | Rejects missing/failed updates and reports that FPS remains fixed |

The missing Expo wrapper method was the immediate root cause: the production
JS call used optional chaining, so neither native implementation was invoked.

## Native verification

### iOS (HaishinKit 2.0.9)

`stream.setVideoSettings` changes `VideoCodecSettings.bitRate`. In HaishinKit
2.0.9, bitrate is deliberately excluded from the settings that invalidate the
compression session; the library applies it directly to the running
`VTCompressionSession`. `mixer.setFrameRate` updates the attached
`AVCaptureDevice` frame durations. The Expo promise now resolves only after
both actor calls finish and returns the resulting HaishinKit configuration.
HaishinKit does not propagate a failed VideoToolbox option update, so this is a
native configuration acknowledgement rather than a hardware measurement.

### Android (StreamPack 3.1.2)

`videoEncoder.bitrate` is StreamPack's dynamic MediaCodec bitrate API; the
configured value is returned after assignment. Replacing `VideoConfig` would
reconfigure the encoder mid-stream, so the thermal path deliberately keeps FPS
fixed and reports `fpsChangeSupported: false`. StreamPack does not expose a
reliable live MediaCodec read-back, so this is also a configuration
acknowledgement rather than a hardware measurement.

## Other thermal load

Bitrate reduction alone does not reduce camera, scaling, preview, or per-frame
encoder work. Resolution and preview changes could reduce those costs, but
they also change capture behavior and need physical-device quality and
stability testing. They are intentionally left out of this root-cause fix.

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
2. Confirm `live:thermal_mitigation` includes `configuredVideoBitrate`,
   `configuredFps`, and `fpsChangeSupported`; any stale native build will
   instead emit `live:thermal_mitigation_failed`.
3. Capture an Xcode Energy Log/System Trace and compare Camera, GPU,
   VideoToolbox, CPU, and radio utilization at the current resolution across
   30, 24, and 15 fps.
4. If the current resolution still reaches serious quickly, test a separately
   scoped 720p capture/encode change. If the preview remains a material GPU
   consumer, test hiding or lowering its refresh rate while recording.
5. Consider emitting fair/serious thermal transitions from native observers
   to remove the current 0–10 second polling latency. The 10-second poll itself
   is not a meaningful heat source.
