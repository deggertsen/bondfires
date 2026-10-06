# bondfire-live-publisher

Expo native module backing segmented camera capture. iOS uses HaishinKit;
Android uses StreamPack. The native RTMP APIs remain in this module, but the
app no longer calls them to publish to Mux.

## Current app lifecycle

`SegmentRecordScreen` uses `startSegmentPreview()` for camera preview,
`startSegmentRecording()` to write local fragmented MP4 media, and
`stopSegmentRecording()` to finalize the recording. `stop()` releases the
native pipeline. Preview does not publish or record media.

Capture operations are serialized through `lib/media/segmentCapture.ts` so
teardown finishes before the next attempt takes the camera. The screen stops
capture on background/interruption and subscribes to native `error` events.
`{ code, message, reason?, elapsedMs? }` carries error details; the optional
numeric fields describe iOS capture interruptions.

The durable journal and R2 uploads live in `lib/media/segmentUploads.ts`.
Capture does not wait for network availability. Keep this native module and
its dependencies until the shared capture pipeline can be separated from the
unused RTMP implementation. See `docs/mux-retirement.md` for the removal scope.

## Retained legacy APIs

`startPreview`, `startCapture`, `start`, RTMP status events, throughput stats,
thermal quality controls and picture-in-picture support belong to the retired
client publishing flow. Their wrapper types remain in `index.ts` and their
implementations remain in Swift/Kotlin. There is no longer a JS live-publisher
store, stall watchdog or thermal polling loop consuming them.

When changing native event payloads, keep the wrapper types and both native
implementations consistent. These retained APIs do not imply that the app can
switch back to Mux ingest; those server creation endpoints are retired.

## Device validation

Native changes require new binaries. Validate preview, start/stop, camera
switching, interruptions, duration limits and microphone/headset routes on
both platforms. The unit tests cannot establish physical microphone routing,
video quality or successful native capture.
