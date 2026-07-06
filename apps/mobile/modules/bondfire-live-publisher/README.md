# bondfire-live-publisher

Expo native module that runs the camera capture pipeline and publishes RTMPS
to Mux. iOS uses HaishinKit; Android uses StreamPack.

## Event contract

The JS source of truth is `packages/app/src/store/livePublisherContract.ts`
(`NATIVE_PUBLISHER_STATUSES`, `NATIVE_PUBLISHER_ERROR_CODES`). Each native
module mirrors it with a `PublisherStatus` enum. **Any new status or error
code must be added in all three places.** JS rejects unknown statuses with a
`live:contract` telemetry error instead of accepting them.

### Status events (`statusChange`)

| Status | Meaning | iOS emits | Android emits |
|---|---|---|---|
| `connecting` | RTMP connection opening | ✅ (module `start`) | ✅ |
| `live` | Publishing / recording running | ✅ | ✅ |
| `reconnecting` | Transient drop, retrying | — (reserved) | — (reserved) |
| `ended` | Intentional stop completed | ✅ | ✅ |
| `errored` | Start/connect failed | ✅ | ✅ |
| `stream_stopped_unexpectedly` | Encoder/stream died without stop() | — (JS stall watchdog emits) | ✅ (`isStreamingFlow`) |
| `endpoint_closed` | Socket closed without stop() | ✅ (isConnected poll) | ✅ (`isOpenFlow`) |

### Health monitoring parity

| Signal | iOS | Android |
|---|---|---|
| Internal encoder/camera errors | capture-session interruption + runtime-error observers | `throwableFlow` |
| Stream stopped | JS zero-throughput watchdog (via real getStats) | `isStreamingFlow` |
| Connection dropped | `Session.isConnected` poll (3s) | `isOpenFlow` |
| Intentional-stop suppression | `isStopping` | `isStoppingIntentionally` |
| Real throughput stats | ✅ (`RTMPStream.info`) | ✅ (`TrafficStats` UID TX-byte deltas) |

`getStats()` marks real measurements with `statsSupported: 1`; the JS stall
watchdog ignores samples without it, so builds that can't measure (or
Android's first baseline-establishing poll) can never false-positive. The
watchdog detects both an encoder that stalls after healthy throughput and a
pipeline that never delivers a first frame (the dominant camera-freeze mode
found in the July 2026 telemetry investigation).

False-positive guards, because Android's measurement is app-wide rather than
per-stream: iOS uses exact-zero semantics (a genuinely low-bitrate stream is
healthy); Android reports samples unmeasurable while the per-UID counter has
never advanced in the session (stale/broken OEM counters) and the JS side
ignores Android samples while a queue upload is in flight (foreign traffic
would otherwise mask a frozen pipeline). The destructive never-started cancel
in LiveRecordScreen is additionally capped at 60s — beyond that the stop path
relies on Mux's authoritative `recordingStarted` flag.

### Microphone routing

iOS routes headset mics through the shared `AVAudioSession`
(`.allowBluetooth` + `.playAndRecord`), so wired and Bluetooth headsets work
without extra code. Android requires explicit routing: StreamPack's default
audio source is `CAMCORDER`, which is pinned to the built-in camcorder mics
and ignores connected headsets. At streamer creation the module picks a route
from the connected input devices:

| Route | Audio source | Extra routing |
|---|---|---|
| Wired / USB headset | `DEFAULT` (follows platform input routing) | none |
| Bluetooth (LE audio or SCO) | `VOICE_COMMUNICATION` | `setCommunicationDevice` (API 31+) / legacy SCO |
| None connected | `CAMCORDER` (built-in) | none |

The Bluetooth claim is released in `cleanupStreamer`. The chosen route is
reported as `audioRoute` in `getStats()` payloads, so `live:stats_sample`
telemetry shows which mic a session recorded from. If the headset
disconnects mid-session the framework reroutes capture to the built-in mic
on its own (with a brief audio gap) and an `AudioDeviceCallback` flips
`audioRoute` to `builtin` so later stats samples stay truthful. Headsets
connected mid-session do not take over until the next session (route is
chosen at creation time).

### Error events (`error`)

`{ code, message }`. Known codes are listed in
`NATIVE_PUBLISHER_ERROR_CODES`; emitting a new code works (JS treats the
event itself as the signal) but add it to the contract for telemetry
greppability.

## Lifecycle

`startPreview()` runs camera+mic+preview with **no network connection** —
nothing is published or recorded until `start()` opens the RTMP connection.
This split is a product requirement (pre-roll must never reach viewers);
preserve it in any refactor.
