# R2 feature parity audit — September 23, 2026

The recording rewrite replaced capture and delivery, but did not replace the Mux transcript-ready webhook. New recordings therefore had no captions, summaries, topic tags, or generated thread titles. Migrated recordings retained their existing captions and metadata.

## Restored by the caption/insights change

- Finalizing a segmented recording queues one durable transcription job. Ordered MP4 fragments are processed in overlapping, bounded windows by Cloudflare Workers AI Whisper Large V3 Turbo. Word timestamps are shifted to the complete recording timeline; overlap words belong to only one window.
- Leases, cursor checks, bounded retries, and a recovery cron protect against duplicate/stalled work. Failures appear in server telemetry. Deleted, expired, or replaced source recordings cannot receive late transcript results.
- Captions are stored privately with the transcript and delivered through the same current membership, moderation, and deletion checks as video. They are not exposed on feed queries.
- Stored R2 transcripts feed the existing OpenRouter summary/tag generator and thread-title generator. No Mux request is necessary. A paginated internal backfill covers existing completed R2 recordings.
- The mobile player now requests R2 captions. Caption readiness updates do not change the currently playing video URL. Installed build 113 needs a mobile update for this wiring; summaries appear through existing reactive queries without an update.

## Remaining differences

| Feature | Status |
| --- | --- |
| New R2 video thumbnails and animated previews | Missing. Feed thumbnail selection only handles legacy playback IDs; new recordings use the fallback artwork. Requires capture/extraction plus private image delivery and feed wiring. |
| Adaptive quality / lower-data rendition | Missing. R2 serves one source rendition. A size preference cannot reduce bandwidth without additional encoded renditions and a master playlist. |
| Mux Data quality analytics | Does not cover R2 URLs. Existing app/Convex playback-error telemetry remains; buffering/startup/abandonment metrics need provider-independent instrumentation. |
| Migrated captions, thumbnails, previews | Preserved in private imports; existing URL actions continue serving them. |
| Growing playback, camera flip, local durable upload recovery | Preserved by segmented capture/delivery; this change does not alter capture. |
| Membership, sharing, feed visibility and deletion | Existing checks retained for video and captions. R2 orphan cleanup remains active. |
| Mux credentials / original assets | Still needed for rollback, pending old-client recovery, and deletion of retained Mux originals. Do not remove as part of a client SDK cleanup. |

Draft PR #238 starts retirement by disabling new Mux ingest and removing unused Mux Data integration. It deliberately retains compatibility with installed clients and original-asset cleanup. Full removal must wait for those gates, rather than breaking playback/recovery to obtain a Mux-free source tree.

Operational commands:

- `npx convex run segmentTranscription:backfill '{}'` schedules captions and insights for existing ready R2 recordings (idempotent).
- Inspect `segmentTranscriptionJobs` and `media:transcription:failed` / `media:insights:failed` telemetry for processing problems.
- Deploy the media Worker with `--env production` for main; the default Worker remains internal.

References: [Cloudflare Whisper model](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/).
