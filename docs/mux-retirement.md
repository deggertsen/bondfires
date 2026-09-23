# Mux retirement: staged removal

Status: draft, not deployed. This change retires **new** Mux recordings and Mux
Data analytics. It does not yet remove the legacy playback, recovery, transcript,
or deletion adapters. Do not delete Mux assets or credentials as part of this PR.

## What changes

- `videos.createLiveStream` and `videos.createMuxDirectUpload` keep their deployed
  argument/response contracts but now authenticate and return an actionable
  update-required error before touching the database or Mux. Recording on the
  production/internal profiles continues through `segmentMedia` and private R2.
- Existing Mux local-backup recovery remains available: an old pending recording
  must not be discarded just because capture moved to R2. This can still create a
  Mux asset; catch-up migration remains necessary until that queue is drained.
- Remove `mux-embed`, its native-player hook, declarations, environment key and
  build checks. The hook only recognized `stream.mux.com`, so it did not monitor
  R2 playback. Existing Convex playback errors, stall/retry events, watch events,
  presence and Crashlytics remain in place.
- Keep the installed-client URL actions and the `mediaImports` lookup ahead of
  Mux fallback. Migrated rows intentionally retain their original IDs and metadata.

## Compatibility and remaining removal gates

1. Restore captions, transcripts, AI summaries and tags for **new** segmented
   videos before considering the replacement complete. This work is a separate
   PR. Mux-generated transcript handling must remain until pending legacy assets
   and caption jobs are drained.
2. Keep a verified import for every playable legacy row (167 were migrated as of
   September 22, 2026). Recheck current data at cutover; a historical count is not
   a guarantee against late recovery uploads or webhooks. Verify authenticated
   playback, captions and seeks before removing Mux fallback.
3. Build 113 calls the existing `videos.getVideoUrls*` / `getThumbnailUrl*` actions
   for migrated videos using legacy playback IDs. Preserve these contracts or
   ship a new client and raise the minimum version before removing them. Do not
   delete Mux fields/indexes merely because playback bytes now come from R2.
4. Remove the old live/direct recorder screens, hooks, persistent upload queue
   and native RTMP dependencies only after deciding how to recover pending local
   backups. Production and internal already use the segmented recorder, while
   non-segmented development/preview profiles will receive the update error from
   retired endpoints. Configure those profiles for segmented media before QA.
5. Account deletion and retention still enqueue deletion of original Mux assets.
   Removing credentials now makes these jobs retry rather than complete. Choose
   an explicit end to the rollback retention period, delete originals through the
   tracked cleanup process, then remove these adapters and their credentials.
6. Once no in-flight legacy uploads/live sessions or transcript jobs remain,
   remove webhook ingestion, Mux reconcile/disable/recovery crons, signing,
   fallback playback and the migration CLI. Retain data migrations and a record
   of import verification; do not silently discard unfinished records.

## Parity audit

| Capability | Current R2 state | Follow-up |
| --- | --- | --- |
| Local capture, live viewing, replay | Supported by segmented recorder and private HLS | Device regression checks remain required |
| Captions and AI summaries/tags | Imported captions preserved; new recordings do not generate them at this branch base | Separate restoration PR; blocker for declaring parity |
| Feed thumbnails and animated previews | Imports contain both; new segmented videos do not generate either | Add private derived media and segment-aware thumbnail requests |
| Adaptive playback quality | One recorded rendition; source HLS fragments retained for imports | Add alternate encodes if network/thermal adaptation is required; `maxVideoSize` cannot create missing variants |
| Audio normalization | Native capture processing exists; no server-side Mux loudness normalization for new recordings | Verify both platforms and microphone/headset routes; do not assume source audio is loudness-normalized |
| Playback telemetry | Convex errors, stalls/retries, watch events and Crashlytics remain; Mux hook already ignored R2 | Consider explicit startup/rebuffer/throughput aggregates for R2 |
| Private access and link revocation | Worker validates capability and current backend access per request | Preserve authorization when adding derived media |
| Retention/account deletion | R2 orphan cleanup exists; original Mux deletion adapter still needed | Drain tracked Mux deletion jobs before removing credentials |
| Rollback | Originals and legacy resolver remain | Choose rollback expiry before destructive cleanup |

## Validation

Run `yarn format` and `yarn validate` before committing. Retirement tests verify
that old creation calls cannot create records or contact Mux and retain the auth
boundary. Legacy-backup tests continue to verify audio/subtitle settings. Existing
import tests cover ledger-based URL resolution, access, revocation and rollback.
No production deployment, new binary, remote asset deletion or credential change
is included in this draft.
