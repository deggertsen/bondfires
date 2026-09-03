# Scale query hardening

This change bounds the highest-risk public feed, camp discovery, digest, and
retention paths before public launch. The implementation follows Convex's
[pagination](https://docs.convex.dev/database/pagination),
[index](https://docs.convex.dev/database/reading-data/indexes/),
[scheduled function](https://docs.convex.dev/scheduling/scheduled-functions),
and [platform limit](https://docs.convex.dev/production/state/limits) guidance.

## Before and after bounds

| Path | Before | After |
| --- | --- | --- |
| Camp discovery | Read every camp and, for admin fallback, every user. | `listPage` reads at most 100 indexed active camps per cursor page and at most 500 memberships for the viewer. The mobile client automatically advances across eligibility-filtered pages. The unchanged legacy array API scans at most 500 rows and returns at most 200 camps. Admin lookup uses `by_is_admin`. |
| Discovery feed | Caller-controlled `limit`, ignored cursor, and a full-table read before filtering. | `listFeedPage` and the legacy wrapper cap requested results at 50 and raw visibility scanning at 150 rows. The legacy cursor is honored. Viewer membership and invite-claim context is capped at 500 rows each. Current mobile clients use cursor pagination. |
| Camp feed | Caller-controlled `limit * 3`. | Results are capped at 50 and raw visibility scanning at 150 rows. |
| Hourly digest sweep | Read every device token in one query, then performed all user work from one action. Per-thread videos and historical digest deliveries were unbounded. | A durable singleton sweep reads 100 tokens per page, schedules at most 100 per-user actions, and atomically schedules one continuation. Per-thread videos and prior deliveries are each capped at 120. A 50-minute lease prevents overlapping hourly runs. Cursor checkpoints make retries idempotent. |
| Bondfire retention | Read every bondfire, then attempted all external deletes and database cascades in one action. Recounted all users' pins and affected users' or camps' content. | The `by_updated` index pages through five expired candidates at a time (hard maximum 10), reads at most 101 responses per candidate, and skips oversized threads for manual follow-up. Mux work and database deletion happen per bounded page. Counter decrements touch only affected users and camps. A six-hour lease and cursor checkpoint make continuation durable and non-overlapping. |
| Archived camp selection | Scanned every camp daily. | Uses `by_status_archived` and selects at most two non-launch camps per run. |

Completed and failed digest/retention runs remain in `maintenanceJobRuns` with
page counts, bounded aggregate statistics, the latest cursor, and a truncated
failure message. Completion and failure also emit structured server telemetry;
no user content or token value is logged.

## Compatibility and rollout

1. Deploy the schema and backend first. Wait for the new indexes
   (`users.by_is_admin`, `camps.by_status_created`,
   `camps.by_status_archived`, and `bondfires.by_updated`) to finish backfilling.
2. Confirm one hourly digest run and one daily retention run create and advance
   their `maintenanceJobRuns` rows. A manual run is not required for deployment.
3. Release the mobile client. Installed versions continue to receive the same
   array shapes from `camps.list` and `bondfires.listFeed`; the new client uses
   `listPage` and `listFeedPage`.
4. Watch `digest:sweep`, `digest:sweep_failed`,
   `bondfire:retention_sweep`, and `bondfire:retention_sweep_failed` during the
   first full cron cycle.

The mobile change is JavaScript-only, but the normal release policy should
decide whether it ships by store build or an eligible OTA update.

## Manual smoke checklist

- Open Camps as signed out, as a teen/adult account, and as a member of a
  frozen camp. Scroll through multiple pages and confirm filtered empty pages
  fill automatically.
- Open Discover, scroll beyond the first page, switch to a joined camp, then
  switch back. Refresh and confirm the list restarts without duplicates.
- Trigger the digest entry point twice within its lease and confirm the second
  run reports the existing run instead of scheduling a second sweep.
- In a non-production environment, run retention with expired, live,
  premium-owned, recently updated, and oversized threads. Confirm only eligible
  threads are removed and the summary counters match.

## Remaining scale debt

- The legacy camp wrapper cannot offer unlimited discovery by design. It scans
  500 indexed rows so old clients remain safe; users in unusually large or
  highly restricted catalogs need the paginated client.
- Feed decoration still performs bounded per-result lookups for latest response
  playback and labels. Its worst case is now finite (150 candidates), but a
  denormalized feed projection would reduce read amplification further.
- A user with device tokens split across token pages can be checked more than
  once in a sweep. Delivery claims remain atomic and prevent duplicate pushes.
- Digest delivery sends still read all tokens for one user. Device registration
  normally keeps this cardinality very small; enforce a per-user device limit
  before supporting unusually large device fleets.
- Retention skips threads with more than 100 responses. These are visible in
  `bondfiresSkippedOversized` and need a separately paginated cascade before
  they can expire automatically.
- Per-bondfire dependent rows (watch events, reports, reads, participants, and
  invite artifacts) and archived-camp deletion cascades remain unbounded within
  one selected parent. Converting every cascade to resumable child-table jobs
  is deliberately deferred rather than mixing a broad data-deletion rewrite
  into this launch hardening change.
- Admin analytics, reconciliation, and a small number of repair jobs still have
  full-table scans. They are not on public request paths, but should be moved to
  checkpointed aggregates before substantially increasing traffic.

## Merge-train notes

This branch touches `convex/schema.ts`, camp/feed visibility, and the two cron
entry-point modules. Rebase after any concurrent age-segmentation, moderation,
or dependency PR that changes those files, regenerate Convex bindings, and run
the full validation suite again. Preserve backend-first deployment so old
mobile versions never call missing functions.
