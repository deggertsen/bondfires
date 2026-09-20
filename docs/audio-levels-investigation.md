# Audio levels investigation — recordings are too quiet

**Date:** 2026-09-19
**Reporter:** David ("have to turn the volume up really loud to hear people")

## Summary

The goal is intelligible speech at a comfortable playback volume on both iOS
and Android. This PR enables normalization for new file uploads and makes an
Android capture experiment observable. **It is not yet a fix for the main
live-recording path.** The Android production default remains unchanged.

The earlier investigation reported quiet live recordings, but the measurements
below do not identify their OS, device, mic route, or physical mic. They cannot
establish that Android communication processing caused the problem. Capture
quality and delivery loudness need separate evaluation.

## Measurements

Reported by the original investigation (not remeasured during this review):
EBU R128 integrated loudness (ffmpeg `ebur128`), 60s sample per clip.
Integrated loudness is LUFS, LRA is LU, and true peak is dBTP.

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

All ten were reported as live-sourced. Their median is -27.0 LUFS, about 3 dB
below Mux's -24 LUFS target; the range includes one clip above target. A 60s
excerpt is not a whole-program measurement. Retain the clip identifiers, exact
sample offsets, build, OS, device, and route in the next controlled comparison.

## What the code and platform docs establish

- The original investigation reported `normalize_audio` absent on recent assets,
  and 39 of 40 recent ready assets live-sourced. Those are a historical sample,
  not a current inventory verified by this review.
- Playback uses `.playback` / `.moviePlayback`. That is appropriate configuration,
  but does not prove the actual output route or eliminate playback as a cause.
- iOS capture uses `.playAndRecord` with `.default` mode and
  `.defaultToSpeaker`. The latter controls output routing. **iOS does expose
  selectable built-in microphone data sources on supported hardware**; choosing
  the built-in port alone does not choose its front/back data source.
  [Apple mic selection](https://developer.apple.com/library/archive/qa/qa1799/)
  explains data sources and the effects of audio session modes. Compare the
  current setup with camera-appropriate selection / `.videoRecording`, including
  camera swaps and headset routing, before changing production behavior.
- Android's `AudioSource` selects a use case. Its gain, physical input, and
  preprocessing depend on device policy. `VOICE_COMMUNICATION` can use AGC/AEC;
  **`CAMCORDER` and `MIC` do not guarantee unprocessed or louder audio**. Android
  documents different near-talk/far-talk tuning, including camcorder AGC.
  [Android preprocessing](https://source.android.com/docs/core/audio/implement-pre-processing)

## Mux normalization scope

[Mux's guide](https://www.mux.com/docs/guides/adjust-audio-levels) documents a
-24 LUFS target, enabled at asset creation, for on-demand assets only. It cannot
be enabled retroactively on an existing asset. The original investigation
reported that the upload API echoed the flag and the live-stream API dropped
it. An echoed flag demonstrates configuration acceptance; the resulting audio
still needs measurement and listening tests.

## Changes in this PR

1. `MUX_NORMALIZE_AUDIO` (Convex env, default `true`) sets `normalize_audio` on
   `createMuxDirectUpload` and `createLiveBackupDirectUpload`. `false` or `0`
   disables it (case-insensitive, whitespace trimmed). Empty/unknown values use
   the default. This covers new uploads and backup recovery uploads, not
   existing assets or the assets produced by live ingest.
2. `EXPO_PUBLIC_LIVE_AUDIO_SOURCE` selects an Android built-in-mic experiment:
   `voice_communication` (default), `camcorder`, `mic`, or `voice_recognition`.
   The native option also accepts these names; unknown values use the default.
   The native **resolved** source now reaches `live:stats_sample.audioSource`.
   The value is absent on iOS and older builds; do not infer the source from the
   build flag alone.
3. Headsets present at capture start retain the existing communication-source
   policy. A session starting with another source skips the app's mid-session
   Bluetooth reroute callback. This is an experiment constraint, not a universal
   Android routing rule. OS-driven routing can still change; the `audioRoute`
   label records app-selected routing, not proof of the physical input. Keep
   headsets disconnected throughout a built-in-mic A/B recording.

The source is chosen when capture is created. Attaching RTMP to an already
running local capture does not change it. Native changes require a new app
build; changing the Expo public flag requires a fresh JS bundle.

## Recommended next approach: normalize the completed replay

For consistent playback across both platforms, first prototype a normalized
on-demand copy of the **completed** live asset. Mux documents creation of a new
on-demand asset from an existing live recording via
`inputs: [{ url: "mux://assets/<completed-asset-id>" }]`; omitting the bounds uses
the entire source. See [asset-based clips](https://www.mux.com/docs/guides/create-clips-from-your-videos).
Combine that request with `normalize_audio: true` and the original playback
policy. **This combination is a proposed experiment, not verified here.**

This is preferable to making every phone transcode/re-upload a recording just
to adjust loudness: it preserves live ingest and can cover iOS, Android, and
potentially old recordings. It adds processing delay and another billable
asset. It does not improve the live broadcast itself or recover clipped speech
or a poor signal-to-noise ratio.

Before production integration:

- Verify output LUFS, true peak, speech clarity, and processing time on controlled
  fixtures. Test the copy API behavior, not just whether it echoes the flag.
- Wait for recording completion; an active live asset can be `ready` while still
  growing. Creating the copy too early truncates the replay.
- Deduplicate work per source asset; retain the current playable asset during
  processing and on failure. Switch only after the replacement is ready.
- Preserve signed/public policy, explicitly associate the replacement with the
  record, and handle webhook ordering, captions, retries, deletion/retention,
  and cleanup of superseded assets. Mux does not copy `passthrough` automatically.

If Mux's fixed target still sounds too quiet, compare a server-side speech
processing stage with a product-selected target (for example, audition -18 and
-16 LUFS with a -1.5 dBTP ceiling). Those are experiment settings, not a declared
platform standard. [FFmpeg loudnorm](https://ffmpeg.org/ffmpeg-filters.html#loudnorm)
supports measured normalization and true-peak limiting. A plain gain increase
is insufficient for clips with little peak headroom: the -32.8 LUFS / -4 dBTP
example would need +8.8 dB just to reach -24 LUFS. A limiter or dynamic processing
is needed to avoid clipping. Avoid applying Mux's -24 normalization afterward
if intentionally mastering to another target.

Keep capture improvements as a parallel investigation: compare Android sources
and iOS mic/mode selection, then consider bounded gain/compression before AAC
encoding if live audio also needs leveling. Add RMS/peak/clipping telemetry at
the capture stage before tuning gain; source names alone cannot measure quality.

## Device and audio validation before rollout

- On at least one iPhone and two Android device families, record the same spoken
  passage at a fixed distance, including soft speech, normal speech, a loud
  phrase, and a pause, in quiet and noisy rooms. Compare with the system Camera
  recording. Hold speaker playback volume constant for listening comparisons.
- Android: A/B each source without a headset; confirm the **resolved** source in
  the first stats event (about 5s after start). Separately test wired/Bluetooth
  capture, plug/unplug, reconnect, and local backup with the production default.
- iOS: compare current capture with video-recording mode/data-source selection
  on both camera orientations; verify actual input and output routes.
- Measure the full output: integrated LUFS, LRA, true peak, and clipping. Listen
  for noise amplification, pumping, muffled speech, and route regressions. Louder
  alone is not a pass. Compare a normalized upload with its exact original.

Automated request tests cover both upload actions, defaults/rollback values,
and preservation of playback policy and captions. A hook test covers native
stats reaching the telemetry event, including builds without the field.
Physical-device sound quality and the proposed normalized replay path remain
unverified; no production default source or live-asset replacement is enabled
by this PR.
