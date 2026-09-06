# Retention cleanup

Expiration is now a database-first claim, not a Mux-delete-then-recheck action.
The eligibility check, parent removal, media inventory, and cleanup job commit
together. A reply, upload, live start, or paid upgrade that commits first is
rechecked; after the claim, the missing parent rejects new attachments. Claims
are irreversible: a later subscription upgrade does not restore expired content.

Free/Plus threads expire 30 days after their newest video's creation. Premium/Pro
(including admin overrides) remain exempt. Pending uploads, processing, live,
and recovery responses preserve a thread. More than 100 subscription rows fails
closed for manual review. Archived Camps still expire after 30 days, excluding
launch Camps; their entire contents are removed regardless of creator tier.

## Work limits and recovery

- Candidate scans checkpoint 25 rows / 1 MB per page, including skipped pages.
- Cleanup claims one child per mutation and drains metadata in pages capped at
  25 rows / 1 MB. Repeated/stale deliveries cannot advance a completed revision.
- Counts decrement transactionally rather than rescanning users' video history.
  Missing pins are hidden and lazily pruned by the existing pin mutation. Billing
  ledger entries are retained; Camp covers and content metadata are removed.
- The media outbox retains failed work with bounded backoff, four resources per
  action, five-minute leases, and 15-second HTTP deadlines. Upload cancellation
  handles already-completed uploads; live streams are disabled and their final
  asset inventory is saved before deletion. 404 is retry-safe success.
- The five-minute recovery cron resumes interrupted scans, database jobs and
  media attempts. Never delete queue rows to clear an error: they are the durable
  record of assets that still need removal.

## Rollout

1. Deploy to staging first with `RETENTION_CLAIMS_ENABLED` unset. Before replacing
   production code, let any old media-first retention actions finish; do not run
   old and new cleanup implementations simultaneously.
2. Deploy the schema/indexes with the functions. No data backfill is required.
   Use `bondfireRetention:previewPage` with `{"kind":"bondfire"}` or
   `{"kind":"camp"}`. Pass each returned `continueCursor` as `cursor` until
   `isDone`, including empty eligible pages. Preview never mutates data.
3. On disposable staging fixtures, set `RETENTION_CLAIMS_ENABLED=true` and invoke
   the existing retention/Camp cron entry points. Verify a new reply, Premium
   upgrade, and live/upload response each prevent a thread claim. Force a Mux
   failure and verify the outbox survives and drains after recovery. Check signed
   playback, thread access, counts, invite invalidation and metadata removal.
4. After staging sign-off, enable the same flag in production. Monitor
   `maintenanceJobRuns` (`retention-bondfire` / `retention-camp`), oldest
   `retentionCleanupJobs.updatedAt`, and `retentionMedia.attempts` / `lastError`.
   Repeated errors or a growing queue need attention even if scan status is complete.

Setting the flag to anything other than `true` pauses **new** claims and preserves
scan cursors. Already-claimed cleanup and provisioning compensation keep running.
Do not roll back to code without these workers while queues remain nonempty.
Unsetting the flag temporarily retains content beyond the normal window; it is
a rollout/emergency control, not a new retention policy.

Local handler tests cover bounded/resumable scans and cleanup, pre-claim races,
late writers, retries, leases and provider protocol order. They do not substitute
for staging verification of Convex transaction behavior or real Mux deletion.
