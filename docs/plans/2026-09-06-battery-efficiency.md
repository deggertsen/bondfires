# Battery efficiency implementation

## Scope

Playback defaults to a persisted 720p ceiling for both new and existing installs.
Profile settings offers 1080p with a battery/data warning. Adaptive playback can
select lower renditions; a 1080p preference cannot add detail to a 720p recording.
Autoplay, background playback/PiP, and general subscription lifecycle are unchanged.

The existing Expo Video patch adds `maxVideoSize` on iOS and Android. It adjusts
native adaptive track selection without replacing the media source. Android must
build `expo-video` from source (configured in the mobile package's autolinking
options), otherwise Expo's precompiled artifact bypasses the patch. Dimensions
preserve portrait, landscape, and square aspect ratios. Limits are player
preferences/constraints, subject to available renditions and already-buffered
segments; they are not an access restriction on Mux URLs.

### Adaptive fallback trial thresholds

- 480p immediately at normalized thermal level 2 (iOS serious / Android severe).
- 480p after 20 seconds continuously at level 1 (fair / moderate).
- Restore the user's ceiling after 60 seconds continuously below level 1.
- Unknown thermal readings do not count toward cooldown; gaps in observation
  cannot establish sustained warmth/cooldown. Thermal history survives video changes.
- Two eligible buffering events within 30 seconds apply a 480p ceiling. Startup,
  scrubbing, recent seeks, and loading with a healthy buffer are excluded.
- Restore after a minute of uninterrupted advancing playback. Thermal and network
  restrictions compose: network recovery cannot override a heat restriction.
- Thermal sampling is every 10 seconds for the active playback session. Adaptation
  never changes autoplay or background playback intent.

## Recording

Live recording defaults to 720p, 24 fps, with a 1.5 Mbps video ceiling and unchanged
128 kbps audio. The bitrate ladder is 1.5 / 1.2 / 1.0 / 0.6 Mbps. Fair/moderate heat
caps recording at 1 Mbps; serious/severe at 0.8 Mbps. Existing critical-heat stops
remain. iOS can reduce frame rate during recording; Android keeps its starting
24 fps to avoid unsafe encoder reconfiguration.

The iOS capture session explicitly requests 720p; Android chooses a supported
camera format up to 720p where available, falling back to device-supported formats.
Local backup recording remains enabled under its existing policy. iOS backup
compression also targets 1.5 Mbps. The legacy Expo Camera path requests 720p and
1.5 Mbps, but does not expose the live publisher's frame-rate control.

## Upload completion and recovery

After transfer, the phone subscribes to an ownership-checked Convex upload status
query instead of polling an action every five seconds. Cached completion resolves
immediately. Successful completion is required before temporary upload cleanup.
Subscription failure or timeout retains the local file and existing retry state;
resuming never re-uploads bytes after `muxUploadCompletedAt` is persisted.

An idempotent mutation schedules recovery after 30 seconds. If still needed,
server checks follow with 60 / 120 / 240 / 240 second delays. Jobs stop on terminal
state or a replaced generation. Transient Mux failures advance the bounded retry
ladder. The existing 15-minute reconciliation cron remains the final safety net.
Duplicate monitor calls within 15 minutes do not schedule another chain. Late
asset-created events cannot regress an already-ready record, including events for
the same asset. Existing live-versus-backup conflict resolution is preserved.

The client waits at most 15 minutes per subscription attempt, then uses the
existing bounded retry/resume path. The server can recover without the phone
remaining open. The old `getMuxUploadStatus` action remains for older clients,
with an upload ownership check.

## Telemetry and presence

Routine telemetry flushes after 60 seconds or when the bounded queue reaches
80 entries. Empty queues have no periodic flush timer. Sends are serialized and
failed entries are retained for a later attempt. Local persistence and crash
breadcrumbs remain. Batching lowers request overhead, not total stored log rows.

Presence heartbeat interval is 60 seconds. Rows expire after 150 seconds, with
physical removal by the existing one-minute cleanup cron; ungraceful departure
can therefore remain visible for roughly 150–210 seconds without other updates.
Explicit departure still removes presence immediately. Viewer results omit
heartbeat timestamps, reducing changes to visible payloads. Heartbeats still
invalidate the server query, but occur half as often.

## Validation and release

Automated coverage includes playback thresholds/recovery, aspect ratios,
subscription cleanup/timeouts, telemetry batching/retry, upload ownership,
deduplication, bounded recovery, missed webhooks, and late/duplicate asset-created
events. Native verification: iOS simulator app build; Android Kotlin compilation
of Expo Video and the live publisher. Full repository validation is required
before commit.

Deploy Convex before distributing the updated app. This change requires a new
native app build; shipping JavaScript alone cannot install the player patch.
Existing app versions can keep using their old polling action. No production
deployment or app distribution is performed by this implementation task.

Before broad rollout, compare physical-device release builds with fixed content,
brightness, and separate Wi-Fi/cellular runs. Check 720p/1080p selection, warm-device
fallback and recovery, constrained network playback, seek/pause/PiP continuity,
24 fps talking-head quality, camera switching, local backup recovery, and uploads
completed while the app is closed. Verify both light and dark settings screens.
Measure energy, temperature, stalls, and recording/upload success. Simulator builds
and unit tests establish correctness coverage, not a measured battery saving.
