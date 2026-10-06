# Recording loudness

The product policy is in `packages/media/src/loudness.ts`: capture speech approaches
-18 dBFS RMS with a -0.5 dBFS sample-peak limiter; completed programs target
-16 LUFS integrated and a -1.5 dBTP true-peak ceiling. RMS and LUFS are different
measurements: capture leveling alone does **not** guarantee integrated loudness.

## Capture implementation

Android and iOS use the same 10 ms block RMS and peak detector, unity minimum gain,
30 dB maximum gain, -55 dBFS noise gate, 350 ms gain rise, 40 ms gain fall and
150 ms limiter release. Peak limiting attacks immediately. Native constants are
checked against the shared policy by Vitest. A -54 dBFS input remains about
-24 dBFS because the gain bound takes priority. Inputs at -16 dBFS remain at unity.

Android retains the existing microphone-owned state (including preview and camera
swaps). iOS retains recorder-owned state across buffers, segments, camera swaps,
and sample-rate changes. The recorder converts a private copy to mono PCM16 at
the original sample rate before creating its CMSampleBuffer. It never changes the
shared mixer buffer or uses track volume for boost. There is no preroll, and the
existing host-time calculation and first-video-frame start rule are unchanged.

`bash scripts/test-speech-leveler.sh` compiles and runs the actual Swift algorithm
and AVFoundation copy/conversion tests on macOS. It covers both 44.1/48 kHz,
quiet speech, healthy input, noise, silence, gain bounds, sudden peaks, active
buffer range, and Float32/PCM16 mono/stereo conversion. This is not an iOS app
build or physical microphone test.

## Lever 3: implemented offline prototype; automatic delivery remains unimplemented

This PR deliberately takes the task's permitted capture-plus-server-follow-up
fallback. It does **not** claim that existing R2 recordings are now normalized.
No production Worker route, growing playlist, checksum, caption, retention rule,
or stored fragment changes in this PR.

`node scripts/audio/normalize-completed.mjs local-completed.m3u8 output.mp4`
implements a separate-compute prototype (Node 22.18+ and FFmpeg). It accepts only
a local, ordered fMP4 playlist with ENDLIST, bounded segment counts/sizes and
recording duration. A trusted future scheduler must obtain the authoritative
completion state from Convex; a local ENDLIST alone is not production authorization.

It measures the entire program with FFmpeg `loudnorm` (EBU R128), computes
`min(30, -16 - integratedLUFS, -1.5 - truePeak)` dB, decodes/re-encodes audio with
that constant gain, copies video, then measures the encoded AAC output. Silence,
nonfinite measurements, and programs below -55 LUFS are rejected. The output is
accepted only if its loudness matches the predicted level within 0.5 LU and its
true peak does not exceed -1.5 dBTP. Existing output files are never overwritten.
Temporary candidates remain in the OS temporary directory for inspection.

This bounded linear approach preserves dynamics. Peak-limited or gain-limited
programs can remain below -16 LUFS; the prototype does not claim to compress them
to target. An AAC true-peak overshoot rejects publication rather than silently
violating the ceiling. A production job needs a bounded attenuation retry policy.
Each FFmpeg invocation has a 120-second wall-time limit; long jobs may be rejected.
The fixture is a synthetic amplitude-modulated tone, not a listening test or a
claim about real speech intelligibility.

### Worker feasibility and follow-up (proposed, not implemented)

Cloudflare documents a 128 MB isolate memory limit and a paid HTTP Worker CPU
budget of 30 seconds by default, configurable up to 300 seconds. An hour of
48 kHz mono PCM16 alone is 345.6 MB, before video, codec memory, or true-peak
oversampling. Streaming DSP could reduce memory, but this repo has no Worker AAC
codec and no demonstrated CPU headroom for it. Commit `2ea14ee` already fixed a
CPU failure during much cheaper transcription base64 preparation. These facts
support keeping decode/DSP/re-encode outside the serving Worker; this is an
engineering feasibility assessment, **not** a measured WASM transcode benchmark.

The cheapest next integration is an on-demand FFmpeg compute job after authoritative
completion, with a durable retry queue and concurrency/duration limits. It must:

1. Snapshot ordered original segment checksums and completion revision, then verify
   each downloaded object. Never schedule from a live/growing prefix.
2. Produce a separate immutable HLS rendition under the recording's existing R2
   prefix so deletion/retention removes derivatives too. Do not rewrite originals.
3. Preserve video/caption time origin and verify audio delay, duration, segment
   ordering, decoded LUFS/true peaks, and derivative checksums before publication.
4. Publish an atomic, revision-pinned pointer only after all derivative objects
   exist and Convex rechecks completion, deletion and authorization. A playback
   session must never mix original initialization with normalized segments.
5. Leave original playback available on failure; serialize publication with deletion
   and clean up uncommitted derivatives. Add race/retry/retention/authorization tests
   and an actual device listening gate before rollout.

Provisioning compute, enqueueing jobs, uploading/remuxing derivative HLS, atomic
rendition selection, and those production integration tests are **unimplemented**.
This is the remaining lever-3 server follow-up, not a deployed delivery feature.

References: [Worker limits](https://developers.cloudflare.com/workers/platform/limits/),
[Worker best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[FFmpeg loudnorm](https://ffmpeg.org/ffmpeg-filters.html#loudnorm).

## Reproducible whole-program verification

```sh
mkdir -p /tmp/bondfires-loudness-fixture
ffmpeg -hide_banner -nostdin -n -f lavfi \
  -i 'aevalsrc=0.018*sin(2*PI*1000*t)*(0.6+0.4*sin(2*PI*0.5*t)):s=48000:d=12' \
  -c:a aac -b:a 128k -f hls -hls_segment_type fmp4 -hls_time 4 \
  -hls_playlist_type vod \
  -hls_segment_filename /tmp/bondfires-loudness-fixture/segment-%06d.m4s \
  /tmp/bondfires-loudness-fixture/index.m3u8
node scripts/audio/normalize-completed.mjs \
  /tmp/bondfires-loudness-fixture/index.m3u8 \
  /tmp/bondfires-loudness-fixture/normalized.mp4
```

Observed with FFmpeg on this branch: input **-41.68 LUFS / -34.84 dBTP**;
encoded output **-16.01 LUFS / -9.16 dBTP**, gain **25.68 dB**. Both the input
and output measurements are decoded whole-program `loudnorm` input measurements,
not predicted gain or the filter's pre-encode output statistics. Use a fresh
temporary directory on reruns; the command refuses to overwrite output.
