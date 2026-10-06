# Mux retirement: staged removal

Status: staged. PR #238 is merged; Phase 1 is tracked in PR #255.

- **PR #238 (merged):** retired **new** Mux ingest (`createLiveStream` /
  `createMuxDirectUpload` now authenticate and return an update-required error
  before touching the database or Mux) and removed the Mux Data (`mux-embed`)
  integration.
- **This change (Phase 1, client removal):** deleted the legacy/dead Mux
  capture, upload and recovery path from the app, since production renders the
  segmented recorder and the retired server endpoints can no longer create a
  Mux asset anywhere.

Still **not** removed: the server playback fallback, webhook ingestion, Mux
crons, and the deletion/retention adapters that hold credentials. Do not delete
Mux assets or credentials as part of this change.

## What this change removes

App-side only. No server contract, schema field, or index is touched.

- Delete the non-segmented recorder screens `LiveRecordScreen` and
  `LegacyRecordScreen`, and route enabled builds to `SegmentRecordScreen`.
  Builds without segmented uploads show an unavailable screen before requesting
  permissions or creating drafts. Production already only rendered the segmented path;
  the other two were unreachable dead code.
- Delete the client live-publisher hook `useLivePublisher` and its
  transport policy (`liveStallDetector`, `liveAbrPrior`, `liveBitratePolicy`,
  `liveUplinkProbe`, `liveReconnectPolicy`, `networkTransport`) and the
  `livePublish.store` / `livePublisherContract` state it drove. Nothing
  provisions RTMP any more.
- Delete the legacy upload queue and its recovery machinery:
  `uploadQueue.store`, `backgroundUpload`, `useResumeUploads`,
  `useLegacyUploadResume`, `useLocalBackupSweep`, `localBackupSweep`,
  `getLocalBackupSessionStats`, `localBackupPolicy`, `waitForUploadCompletion`,
  `useUploadCompletion`, `videoProcessing`, and `UploadProgressCard`. The
  client no longer ingests a local MP4 back through a Mux direct upload.
- Delete the now-dead recording watchdog, recording store and resource lock.
  The segmented recorder owns its lifecycle locally; background tab work
  remains gated by screen focus.
- Simplify the app-wide upload status banner to segmented-only
  (`uploadStatus`), dropping the legacy-queue branch, terminal failure state
  and progress %.
- Remove the Live Publisher developer toggle and its preference/action; it no
  longer selects a recording path.

`docs/mux-retirement.md` gate 4 ("remove the old live/direct recorder screens,
hooks and persistent upload queue") is therefore complete for the client. The
native RTMP module in `modules/bondfire-live-publisher` still ships; it backs
segmented capture, so it stays until its shared capture pipeline can be
separated from the unused RTMP APIs.

## What still remains (server-side, later phases)

1. **Playback fallback.** `resolvePlaybackUrls` still returns `stream.mux.com`
   URLs for a row with no import, as a last resort for errored legacy rows.
2. **Installed-client URL contracts.** `getVideoUrls` / `getVideoUrlsBatch` /
   `getThumbnailUrl(s)` still accept `muxPlaybackId`. Older builds send it and
   receive Mux HLS. Removing these needs a min-version bump.
3. **Deletion/retention adapters.** Account deletion and retention still
   enqueue deletion of original Mux assets; removing credentials now makes
   those jobs retry rather than complete. Close the rollback window first.
4. **Webhook ingestion + crons.** `convex/http.ts` `/mux/webhook`, the
   reconcile-stuck / disable-stale / purge crons, and Mux signing.
5. **Data fields/indexes.** The `mux*` fields and `by_mux_*` indexes stay — the
   `mediaImports` ledger resolves imports by `muxPlaybackId`, and migrated rows
   keep their original metadata.

The parity audit below still applies (captions/insights for new recordings
shipped separately; thumbnails, previews and adaptive quality remain open).

## Compatibility and remaining removal gates

1. Restore captions, transcripts, AI summaries and tags for **new** segmented
   videos before considering the replacement complete. (Shipped separately;
   imported Mux transcripts remain handled.)
2. Keep a verified import for every playable legacy row (167 verified on
   September 22, 2026; re-verified 2026-10-05). Recheck current data at cutover.
3. Preserve `getVideoUrls*` / `getThumbnailUrl*` contracts or ship a new client
   and raise the minimum version before removing the Mux fallback.
4. Remove the old live/direct recorder screens, hooks and persistent upload
   queue. **Client side done in this change.** Native RTMP dependencies remain
   a separate task because their module also backs segmented capture.
5. Account deletion and retention still enqueue deletion of original Mux
   assets. Choose an explicit end to the rollback retention period, delete
   originals through the tracked cleanup process, then remove these adapters and
   their credentials.
6. Once no in-flight legacy uploads/live sessions or transcript jobs remain,
   remove webhook ingestion, Mux reconcile/disable/recovery crons, signing,
   fallback playback and the migration CLI.

## Parity audit

| Capability | Current R2 state | Follow-up |
| --- | --- | --- |
| Local capture, live viewing, replay | Supported by segmented recorder and private HLS | Device regression checks remain required |
| Captions and AI summaries/tags | Restored for new recordings; imported captions preserved | Verify backfill coverage |
| Feed thumbnails and animated previews | Imports contain both; new segmented videos do not generate either | Add private derived media and segment-aware thumbnail requests |
| Adaptive playback quality | One recorded rendition; source HLS fragments retained for imports | Add alternate encodes if network/thermal adaptation is required |
| Audio normalization | Native capture processing exists; no server-side Mux loudness normalization for new recordings | Verify both platforms and microphone/headset routes |
| Playback telemetry | Convex errors, stalls/retries, watch events and Crashlytics remain | Consider explicit startup/rebuffer/throughput aggregates for R2 |
| Private access and link revocation | Worker validates capability and current backend access per request | Preserve authorization when adding derived media |
| Retention/account deletion | R2 orphan cleanup exists; original Mux deletion adapter still needed | Drain tracked Mux deletion jobs before removing credentials |
| Rollback | Originals and legacy resolver remain | Choose rollback expiry before destructive cleanup |

## Validation

Run `yarn format` and `yarn validate` before committing. Retirement tests verify
that old creation calls cannot create records or contact Mux and retain the auth
boundary. Import tests cover ledger-based URL resolution, access, revocation and
rollback. The create availability regression test verifies that a disabled
uploader cannot lead into permissions, draft setup or recording. No production deployment, new
binary, remote asset deletion or credential change is included.
