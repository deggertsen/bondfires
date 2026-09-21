# Historical Mux → R2 migration

Historical videos use the same record IDs, permissions, timestamps, reactions, and captions. `mediaImports` is a deployment-key-only ledger; `staging` serves Mux, `ready` resolves existing playback actions to private R2 HLS, and `rollback` restores Mux URLs. No mobile build or recording publication mutation is involved, so imports do not reorder feeds or resend notifications.

Each import stores a complete Mux master as ordered 8 MiB archive parts plus a manifest, H.264/AAC fMP4 HLS, WebVTT captions, thumbnail, and animated preview. Compatible masters are remuxed. Unsupported codecs or oversized/long fragments are re-encoded for delivery while the master remains unchanged. The runner decodes the complete HLS output, compares duration, and reads every R2 object back to verify SHA-256 before activating. It removes local media only after successful activation; manifests and per-record checkpoints remain.

The private Worker checks current Convex authorization on every playback request, including captions and images. Source archives are operator-only. Deleted/replaced records immediately lose access; a daily paginated cleanup removes their R2 objects. Original Mux assets remain available for rollback and previously issued URLs. This migration does not retire Mux credentials, webhooks, or delete assets.

## Operator procedure

1. Export a fresh main Convex snapshot, including file storage. Build `inventory.json` from ready `bondfires` / `bondfireVideos` with a Mux asset and playback ID, excluding segmented recordings. Preserve `_id`, `table`, `muxAssetId`, and `muxPlaybackId`.
2. Use an ignored, private working directory, for example `apps/mobile/build/mux-r2-migration`. Store `secrets.json` with the main deployment's `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `MUX_SIGNING_KEY_ID`, `MUX_SIGNING_PRIVATE_KEY`, and `MEDIA_WORKER_SECRET`; never commit credentials or signed URLs. The runner checks that `.env.local` contains the main deployment key.
3. Deploy the validated Convex and production Worker changes. Test one QA-accessible video first: `node scripts/migrate-mux-r2.mjs apps/mobile/build/mux-r2-migration 1 1`.
4. Confirm authorized HLS, seeking, captions, images, denied archive access, and unauthenticated denial. Then run all eligible records, with bounded concurrency: `node scripts/migrate-mux-r2.mjs apps/mobile/build/mux-r2-migration 166 4`.
5. Re-run the same command after interruption. Completed checkpoints are skipped; identical uploads are idempotent and different bytes cannot overwrite an existing import. Review `results.json` and all per-record checkpoints. Do not activate an import with failed validation.
6. Roll back an individual import using `npx convex run mediaImports:rollback '{"importId":"..."}'`. Newly resolved URLs return to Mux; already issued R2 URLs are revoked immediately. An open player must reload to obtain the restored URL. Keep the manifest and Mux originals until the rollback window is explicitly closed.

To reconstruct a master, download its `archive-000000.bin`, `archive-000001.bin`, etc. with the operator credential, concatenate in the manifest's `archive` order, and verify `sourceSha256` and `sourceSize`. Archive files and `manifest.json` are never viewer-accessible.
