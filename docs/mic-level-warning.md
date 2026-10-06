# Recording microphone warning

Stacked on #254. The private R2 segmented recorder exposes `micLevelDb` before
capture gain and `appliedGainDb` after the gain/peak-limiter decision. Input power
uses a one-second exponential average; silence is clamped to -120 dBFS for finite
JSON values. Native levelers derive `micLowThresholdDb` as
`20 * log10(targetRms / maxGain) - 2`: approximately -50 dBFS with the current
-18 dBFS target and 30 dB gain bound. Input at the rescue floor (~-48) does not warn.

The R2 record screen polls every 250 ms, only after native recording starts and
while the screen/app is active. `createMicLevelWarning` requires 10 seconds of
consecutive low measurements, allowing less than 500 ms above the threshold.
Silence/breath gaps remain low. Recovery for 500 ms clears the indicator and
re-arms a fresh 10-second window. Missing fields, native mute, unchanged PCM sample
counts, capture restarts, failed polls, and sampling gaps over 750 ms reset the
window. The rule applies to the smoothed level, so smoothing and poll cadence add
some latency. It does not infer continuity from the legacy five-second stats tick.

Measurements follow the existing leveler's capture lifetime and survive camera
swaps. iOS owns them in the segmented recorder; Android owns them in the capture
microphone source (including preview). The JS detector never counts preview time.
`micSampleCount` provides freshness independently of network traffic. Measurement
fields are absent until actual PCM arrives. `statsSupported` retains its existing
**bitrate** meaning; valid mic samples do not turn unmeasurable bitrate zeros into
supported samples for the stall watchdog.

`live:audio_level_warning` fires on each hidden-to-visible transition, with input,
applied gain, threshold, recording ID and window duration. `live:stats_sample`
includes the levels (first recording poll, then every 30 seconds on the R2 screen).
The compact indicator uses theme tokens and passes touches through to recording
controls. It never changes gain, stops capture or interrupts uploads.

## Verification

- `yarn validate`: TypeScript, Vitest (including Worker/media tests), repository checks and Biome.
- `yarn test:audio:swift`: real Swift DSP and AVAudioPCMBuffer copy/conversion, including exposed pre-gain values.
- `python3 scripts/test-speech-leveler-jvm.py`: Kotlin DSP/exposure tests on JVM.
- With an attached Android device: `cd apps/mobile/android && ./gradlew :bondfire-live-publisher:connectedDebugAndroidTest`.

Physical QA: record very quiet speech for >10 seconds, speak normally to clear,
then repeat; include breath gaps, camera swaps, headset route changes and stop/start.
Preview alone must never warn. Check light/dark themes and larger accessibility text.
Native mute must suppress/re-arm the warning. These device checks are distinct from
unit tests and still need a physical microphone.
