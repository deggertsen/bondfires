# R2-only media runtime

New recordings use native segmented R2. Historical imports keep the same record
IDs, ownership, captions, thumbnails and previews. `mediaImports.by_record` now
resolves imported media from a Bondfire/response ID; a Mux playback ID is no longer
required by current clients. Existing source IDs remain immutable migration
provenance and compatibility hints for installed clients, not a network dependency.

This completes the runtime retirement begun in PR #238 (new Mux ingest disabled)
and PR #255 (legacy client recording, upload queues and recovery removed). The
`bondfire-live-publisher` native module still supports segmented R2 capture and
must remain installed. Native R2 currently serves one rendition and has no generated
thumbnails or previews; imported media retains its migrated thumbnails and previews.

## Read-only deployment audit — October 20, 2026

| Deployment | Native R2 ready videos | Ready historical R2 imports | Playable legacy videos without a ready import | Legacy upload/recovery records | Active legacy sessions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Main (`ideal-akita-27`) | 85 | 167 | 0 | 0 | 0 |
| Internal (`lovely-malamute-525`) | 22 | 0 | 0 | 0 | 0 |

Main had 18 Bondfires, 285 responses, and 326 ended legacy sessions. Internal had
2 Bondfires, 20 responses, and no legacy sessions. Both external cleanup queues
were empty in both deployments. The recovery check included `live`,
`waiting_for_upload`, `processing`, and `awaiting_recovery` records without a
native segment recording. These are point-in-time inventories, not traffic or
installed-binary measurements. No deployment data was changed by this audit.
The scheduled-function inventories were also fully scanned: 5,018 entries on
main and 2,366 on internal, with no pending or in-progress jobs at audit time.

## Runtime changes

- Playback, previews, captions and thumbnails resolve only to authorized R2 imports.
  Missing, mismatched, rolled-back and unauthorized imports return unavailable
  results; they never fall back to a public provider URL. Batch isolation remains.
- Record creation, local upload retry and recovery use the existing native R2 path.
  Legacy upload, backup-upload and session endpoints authenticate and return an
  upgrade error before writing records, scheduling work or contacting a provider.
- Provider signing, polling, webhook processing, subtitle fetching and maintenance
  crons are removed. The former webhook route returns 410 without processing data.
- AI summaries use stored transcripts. Missing historical transcripts are skipped;
  the retired CDN is never fetched. Playback captions still come from the R2 import.
- My Fires uses one descending chronological response scan for activity, avatars
  and its response reference. It stops after four visible existing authors and the
  newest timestamp's ties, capped at 250. Dense fixtures read five response
  documents including lookahead; sparse fixtures read at most 250. Counts still
  come from `bondfires.videoCount`, and first-unwatched lookup stays after slicing.
- Thumbnails use the chosen response's import, falling back to the spark's import
  when the response has no imported thumbnail. Native recordings currently have no
  generated thumbnail. There is no extra scan for older imported responses; in a
  mixed thread whose spark is native, this may show the placeholder even if a much
  older response had an imported thumbnail.

## External asset retirement and release

The migration retained original provider assets for rollback. Removing application
code does **not** prove those copies were deleted or close the provider account.
Do not drop historical IDs, import ledgers, R2 objects, or cleanup records.

1. Recheck both deployment inventories before release, including outstanding legacy
   jobs and client backups. The audit above found no server-side recovery work;
   files held only on offline, obsolete clients cannot be inventoried server-side.
2. Deploy the compatible backend before a mobile build that sends record-only
   playback requests. Existing released clients can still send their old provider
   fields, which remain accepted and source-checked. Native R2 upload/recovery is
   unchanged. Do not use a pre-R2 binary as a rollback target.
3. Verify imported and native R2 playback, captions, thumbnails, access revocation,
   and deletion on both released platforms. Retire retained external copies and
   provider resources through the operator process only after this verification.
   This PR does not perform that irreversible external cleanup or remove secrets.
4. Set `LEGACY_MEDIA_RETIREMENT_CONFIRMED=1` in each deployment **only after external
   user-media copies have been removed**. Until then, account deletion archives the
   provider resource IDs and stays pending instead of falsely reporting external
   deletion. Once confirmed, those items become `retired` and the R2/database
   deletion workflow proceeds. Each bounded batch archives IDs and updates its
   completion markers in one transaction. The durable `retentionMedia` ledger remains for
   operator reconciliation; the runtime no longer contacts Mux or retries its API.
   Unused Mux recovery helpers and API-deletion lease/retry functions are removed;
   native R2 recovery and the legacy client upgrade responses remain.

Native segment cleanup and imported-media cleanup still revoke access immediately
through their existing authorization checks and remove R2 objects through their
existing cleanup paths. Source IDs and old schema fields can be removed in a later
schema migration once installed-client compatibility and provenance requirements
are no longer needed. The historical migration script is an operator tool, not a
runtime dependency.
