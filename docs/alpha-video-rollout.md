# Alpha video rollout

## Deployment ownership

The `production` EAS build profile connects to the existing main database at
`https://ideal-akita-27.convex.cloud`. It explicitly enables local segmented
recording. Google Play alpha is a distribution track, independent of the EAS
profile name. Use existing main-backend accounts after upgrading from an isolated
internal build; internal accounts and test recordings are not copied into main.

Main media uses the private `bondfires-video` R2 bucket and `bondfires-media`
Worker. Deploy it with `npx wrangler deploy --env production` in
`infrastructure/media`. Main Convex requires `SEGMENT_MEDIA_ENABLED=1`,
`MEDIA_WORKER_URL`, `MEDIA_TOKEN_SECRET`, and `MEDIA_WORKER_SECRET`. The two secrets
must match the production Worker and differ from internal credentials. Public
bucket access stays disabled. The private `/internal-media` callback retains its
historical route name; it still requires the shared secret and signed capability.

The internal build profile, `lovely-malamute-525`, `bondfires-internal-video`, and
`bondfires-internal-media` remain an isolated test environment. Its legacy
`INTERNAL_SEGMENT_MEDIA` flag cannot enable main. Both client and server reject
unknown deployments and mismatched build environments.

## Release sequence

1. Merge compatible PRs after combined validation, including native capture.
2. Export a main Convex snapshot including storage. Provision main media with
   distinct credentials. Deploy the additive backend/schema before mobile clients.
3. Enable main segmented media and smoke-test private creation, ordered upload,
   finalization, authenticated playback, ranges and revocation using the dedicated
   QA account. Verify legacy Mux playback still resolves. Do not bulk-import or
   replace the internal database over main.
4. Build both platforms with the production profile; inspect the packaged version,
   backend URL and capture flag. Distribute to Play alpha and the selected
   TestFlight group. Do not ship these builds to the public App Store/Play track.
5. Existing Mux videos keep their provider IDs, captions and thumbnails. Old
   clients can still use the existing Mux endpoints while new clients record to R2.

Social sign-in code is merged but provider buttons remain hidden until the
production Apple/Google credentials are configured and provider/device acceptance
is completed. Existing password login remains available.

## Rollback

Keep Mux credentials, webhooks and existing assets throughout the transition.
A capture rollback should ship a higher build number with
`EXPO_PUBLIC_SEGMENT_MEDIA=0`, retaining segmented playback and the deployed media
backend. Disabling the backend flag blocks playback too, so it is an emergency
service shutdown, not the normal capture rollback. Old pre-rewrite binaries cannot
play new R2 recordings; do not assume simply reinstalling one is a full rollback.
Do not restore a database snapshot over newly created user data as a routine rollback.

## Historical Mux migration — next stage

Read-only inventory on 2026-09-21 found 166 ready records, representing about
739 minutes. All 166 referenced assets are present in Mux and have text tracks.
There are 211 distinct referenced Mux asset IDs across all record states and
380 assets in the Mux environment. Do not migrate/delete every environment asset
blindly: errored/interrupted records and unreferenced assets require reconciliation.

The rollout does not migrate or delete these historical assets. A resumable
migration worker and a playback cutover are separate implementation work:

1. Snapshot each eligible record's ID, source asset, captions, thumbnail, duration,
   ownership and current provider. Deduplicate by asset ID; maintain a persistent
   migration ledger with attempts, checksums, validation and cutover status.
2. Request Mux temporary master access (or an appropriate static rendition). Copy
   the source into a private R2 archive. Export captions as VTT and preserve the
   thumbnail. Download URLs are temporary bearer credentials and must not be logged.
3. Package a streaming H.264/AAC fMP4 rendition for R2. Remux compatible media to
   preserve quality; encode only where codecs, keyframe spacing or segment limits
   require it. Keep the archived source. The existing ingest contract is bounded
   to 8 MiB/fragment and 15 seconds/fragment; an arbitrary MP4 cannot just be uploaded
   as a recording segment. Run this media processing in a batch process/container,
   not the request-handling Cloudflare Worker or a Convex mutation.
4. Validate whole-file checksums, all segment decodes, audio presence, duration and
   caption timing. Test start/middle/end, seeking, Android/iOS playback, access
   revocation and deletion. Add authorized delivery of imported caption/thumbnail
   objects before cutting over: the current segmented path does not implement them.
5. Atomically attach the verified media to the same Bondfire/response, conditional
   on the original source still matching and the record remaining eligible. Preserve
   IDs, reactions, comments, ownership, timestamps, feeds and notification history.
   Do not invoke the new-recording publication/notification path for imports.
6. Cut over a small batch, inspect results, then continue. Retain original Mux IDs
   and assets for fallback/older clients. Remove assets only after verification and
   an explicit retirement decision; never mix cleanup into a failed import.

Reference: [Mux master downloads](https://www.mux.com/docs/guides/download-for-offline-editing)
and [static renditions](https://www.mux.com/docs/guides/enable-static-mp4-renditions).
