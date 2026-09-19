# Audio levels investigation — recordings are too quiet

**Date:** 2026-09-19
**Reporter:** David ("have to turn the volume up really loud to hear people")

## Summary

Recorded audio was measured well below Mux's loudness target, and no loudness
normalization was applied anywhere. Two independent causes:

1. **No loudness normalization on ingest.** Measured integrated loudness on 10
   recent production clips ranged **-22.1 to -39.3 LUFS** against Mux's
   **-24 LUFS** normalization target — median ~4 dB under, worst cases 8–15 dB
   under. Nothing in our pipeline asked Mux to normalize.
2. **Capture level.** Recordings are a phone mic at arm's length with
   device/comms AGC, with a wide loudness range (LRA ~8–10 LU): speech sits low
   relative to peaks, so raising the volume to hear speech makes peaks jump.

## Measurements

EBU R128 integrated loudness (ffmpeg `ebur128`), 60s sample per clip:

| Integrated | LRA | True peak | Source |
|---|---|---|---|
| -22.1 | 3.9 | -5.4 | live |
| -24.0 | 8.6 | -3.2 | live |
| -24.1 | 8.5 | -4.8 | live |
| -25.6 | 9.8 | -4.4 | live |
| -25.8 | 8.0 | -4.7 | live |
| -28.2 | 8.5 | -10.3 | live |
| -29.0 | 10.2 | -8.6 | live |
| -29.4 | 8.3 | -6.7 | live |
| -32.8 | 8.7 | -4.0 | live |
| -39.3 | 5.4 | -17.5 | live |

All ten are live-sourced recordings.

## What was checked

- **Mux ingest:** `normalize_audio` was absent on all recent ready assets. It is
  set on neither the direct-upload nor the live-stream path.
- **Playback (`expo-video`):** sets `.playback` / `.moviePlayback` correctly, so
  output is not misrouted to the earpiece. Not the cause.
- **iOS capture (`bondfire-live-publisher`):** `.playAndRecord` +
  `.defaultToSpeaker` + built-in mic, mono 44.1k AAC. `.defaultToSpeaker` is a
  *playback* routing option, not a capture input — iPhone has no separately
  addressable "speakerphone mic".
- **Android capture:** `VOICE_COMMUNICATION` as the built-in `AudioSource`,
  which engages comms-style AGC/noise suppression.

## Key constraint: Mux ignores `normalize_audio` for live

Verified against the Mux API:

- `POST /video/v1/uploads` with `new_asset_settings.normalize_audio=true` →
  echoed back as `true`. **Honored.**
- `POST /video/v1/live-streams` with
  `new_asset_settings.normalize_audio=true` → HTTP 201, but the field is
  **silently dropped** from the returned `new_asset_settings`. **Not honored.**

This matters because **39 of 40 recent ready assets are live-sourced**. Mux's
own docs confirm normalization "only applies to on-demand assets ... but not
live streams".

## Changes in this PR

1. **`MUX_NORMALIZE_AUDIO` (Convex env, default `true`)** — sets
   `normalize_audio` on the direct-upload asset payloads:
   - `createMuxDirectUpload` (legacy/uploaded recordings)
   - `createLiveBackupDirectUpload` (live-backup recovery re-ingest)

   This covers the paths where Mux honors the flag. It does **not** cover
   live-sourced VODs, for the reason above.

2. **Android mic source experiment** — the `audioSource` option
   (`EXPO_PUBLIC_LIVE_AUDIO_SOURCE`, default `voice_communication`) selects the
   built-in-mic `MediaRecorder.AudioSource`: `voice_communication` (default,
   comms AGC), `camcorder`, `mic`, `voice_recognition`. The resolved value is
   reported as `audioSource` in `getStats()` so `live:stats_sample` telemetry
   proves which source a session actually used.

   A non-default source applies only when no headset is connected (headset
   routing needs `VOICE_COMMUNICATION`), and it disables the mid-session
   Bluetooth reroute for that session — an `AudioRecord` pinned to
   CAMCORDER/MIC cannot follow a `setCommunicationDevice` call.

## Why the Android experiment is the main lever

Since Mux will not normalize live-sourced recordings, and nearly all recordings
are live, capture level is where the fix has to happen. Comparing sources is the
cheapest way to learn whether comms AGC is attenuating speech on Android.

## Follow-ups (not in this PR)

- If the Android source experiment does not move the needle, add client-side
  loudness normalization (e.g. ffmpeg `loudnorm`) before upload, or move live
  recordings onto an upload path Mux will normalize.
- Instrument a `live:stats_sample` audio-level signal (e.g. RMS/peak from the
  encoder) so quiet captures are detectable in production without manual
  measurement.
