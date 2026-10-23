# Transcription 503 investigation — 2026-10-23

## Findings and limits

Production is **not verified fixed**. No Worker or Convex deployment, job reset,
requeue, or cron change was performed. Read-only Convex queries and R2 GETs were
used, plus direct transcription requests that do not persist job/transcript data.

The six reconstructed historical failure windows below all returned HTTP 200
when replayed on October 23 at 21:34–21:35 UTC. The live `bondfires-media` tail
reported **`outcome: ok`, `exceptions: []`**, and 271–484 ms CPU. No failing
`exceededCpu` or provider exception was captured. These successful replays do not
prove the cause of the earlier 503s or rule out an intermittent provider failure.

The deployed Worker is version `354c6628-1e8d-4236-9252-ed23647a2bc7`, created
**2026-09-23 20:17:14 UTC**, confirmed by both the tail and the deployment API.
A read-only download of that version's source still contains the old
`String.fromCharCode(...part.subarray(...))` / `btoa(binary.join(''))` path.
It does **not** contain #247's encoder or #251's probes. Consequently, merging
#247 did not put that change into the currently active production Worker. The
successful replay responses also lacked `probe`, consistent with that source.
This deployment mismatch is confirmed; attribution of the historical 503s to CPU
is not.

Historical Workers Observability query access was attempted for the exact
failure interval using a dry, read-only telemetry query. Cloudflare returned HTTP
403, code **10000, `Authentication error`**, so the original failure outcomes
could not be retrieved with the available Wrangler credentials. Initial Python
replays hit edge error 1010; setting an explicit diagnostic User-Agent reached
the Worker. This was not the Worker's secret-check 403.

## Recordings and windows

The production snapshot had all three jobs `ready`, attempts `0`. Their cursors
were 51, 60, and 176 respectively. The first two recordings share an owner; the
third has a different owner. No personal owner details or media are included here.
The audit events are scheduled retries, not evidence that these jobs stopped.

Ranges are start-inclusive and end-exclusive. Byte counts exclude `init.mp4`.
Each window was reconstructed from stored fragment sizes and durations, including
one preceding context fragment and the existing 30-second / 12-MiB bounds.

| Recording ID | Failed cursor | Range | Fragment bytes | Stored seconds | Replay CPU ms |
| --- | ---: | --- | ---: | ---: | ---: |
| `rs7084pv2zgg5s4rcn29rdrgmx8gr2rh` | 41 | [40,47) | 7,792,157 | 29.674504 | 333 |
| `rs7f1tcpw6z69cgg1ysapj3j1x8gspkx` | 21 | [20,26) | 7,725,026 | 25.624729 | 312 |
| `rs7f1tcpw6z69cgg1ysapj3j1x8gspkx` | 55 | [54,60) | 5,992,370 | 21.935628 | 311 |
| `rs7bfjb6c8cm6k9stx9mtsx7qn8gnpsw` | 51 | [50,57) | 5,733,230 | 28.032000 | 271 |
| `rs7bfjb6c8cm6k9stx9mtsx7qn8gnpsw` | 96 | [95,102) | 5,764,537 | 28.044333 | 283 |
| `rs7bfjb6c8cm6k9stx9mtsx7qn8gnpsw` | 141 | [140,147) | 5,739,752 | 28.033667 | 484 |

The production bucket used for media inspection was `bondfires-video`, not the
internal bucket. The inspected initialization/fragment pair had AAC (`mp4a`) and
valid audio/video timing; no torn-media evidence was found in these replays.

Tail capture used `wrangler tail bondfires-media --format json` and incremental
`json.JSONDecoder().raw_decode`, because output is concatenated formatted objects,
not JSONL. Only outcome, version, timing, exception names/messages, and HTTP
status were retained; request headers and transcription content were discarded.
Using an explicit Worker name together with `--env production` incorrectly
selected `bondfires-media-production` with the initial CLI; the exact-name tail
without that flag captured the correct Worker.

## Code change and measured scope

Main already assembles the window into one preallocated `Uint8Array`. It also
already contains #247's ASCII-buffer encoder. This change replaces that remaining
JavaScript loop and ASCII allocation/decoding with the native `node:buffer`
base64 encoder. `Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)`
uses the exact view without another input copy. The existing `nodejs_compat`
flag supports this API; TypeScript now includes the repository's existing Node
types. No dependency, CPU-limit, AI-model, window, or retry-policy change is needed.

This is an additional measured CPU reduction, **not a replay of #247 and not a
confirmed fix for the historical 503 cause**. It does not resolve the deployment
mismatch by itself.

Local Node measurements on synthetic bytes (five warmups, median of 30 calls):

| Input bytes | Main ASCII encoder ms | Native encoder ms | Window copy ms |
| ---: | ---: | ---: | ---: |
| 7,792,157 | 44.445 | 3.120 | 1.652 |
| 12,845,056 (maximum window + init) | 71.121 | 5.138 | 3.562 |

Initialization/codec inspection and fourteen timing inspections (two per fragment,
matching the seven-fragment preparation path) took a median 0.369 ms on the
inspected production fragment. These local measurements identify the remaining
encoding cost; they are not production CPU profiles or an inference benchmark.
The AI call was not changed.

A local workerd comparison with the existing compatibility date/flag, synthetic
bytes, five warmups and median of 15 calls also reduced encoding elapsed time:
229 to 21 ms at 7,792,157 bytes and 154 to 33 ms at 12,845,056 bytes. Host load
made these timings noisy (including the non-monotonic baseline); treat them as
runtime compatibility and directional evidence, not a production latency promise.

Regression tests cover nonzero-offset views with all padding cases, neighboring
bytes remaining unchanged, and byte-exact round-trip encoding at the maximum
window plus initialization size. Existing randomized/padding tests remain.

## Follow-up after review

A separately authorized production Worker deployment is required to activate any
of the main-branch fixes. Verify the deployed version and source, replay these
windows with a live tail, and monitor new failures before claiming resolution.
If 503s recur, capture the failing outcome/exception and investigate that path;
do not infer CPU exhaustion solely from the HTTP status. Historical telemetry
access would help confirm the original incident. Do not reset or requeue the
already completed jobs.
