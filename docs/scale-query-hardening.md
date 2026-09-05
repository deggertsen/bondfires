# Discovery and digest scaling

Camp discovery and the all-Camps feed now use cursor pagination. Existing
installed clients keep bounded array APIs. Every page preserves age,
membership, block, suspension, and moderation rules; hidden pages continue
loading until visible results appear or the cursor is exhausted.

## Work bounds

| Path | Bound |
| --- | --- |
| Camp discovery | 100 indexed Camp rows per page; 500 cached memberships. The first page also includes up to 500 frozen/grace member Camps. |
| Legacy Camp list | 500 raw Camp rows, at most 200 returned. |
| Discovery feed | Requests capped at 50; at most 150 raw rows scanned/returned per page. All visible rows in the scan are returned so the cursor cannot skip them. |
| Camp feed | At most 150 raw rows scanned, 50 visible results returned. |
| Response thumbnail | Checks the latest 10 responses; omits blocked, held, removed, or expired media. |
| Digest sweep | 100 device-token rows per page, at most 100 user actions plus one continuation. |
| Per-user digest | 75 threads, at most 600 response candidates total (120 per thread), 300 Camp roots, 120 prior deliveries, at most 30 items. |

Paginated database reads override caller-supplied read budgets and cap bytes
at 2 MB per call. Large records may therefore produce shorter pages.
Authorization context overflow uses indexed checks for the particular Camp,
invitation, or creator instead of silently denying an existing grant or
truncating a user's block list.

Digest pages use a 50-minute lease and atomic cursor checkpoints. Stale or
duplicate checkpoints cannot schedule the same page's user actions twice.
Delivery claims deduplicate individual videos even when a user has tokens
on multiple pages. Digest and nudge collectors recheck current age, private
Hearth access, blocks, moderation, and suspension.

## Review and rollout

This PR is stacked on #222. Merge #222 first, then this PR. Deploy backend
functions and the `users.by_is_admin` and `camps.by_status_created` indexes
before releasing the client. The new `maintenanceJobRuns` table stores one
latest run per job, with its cursor, status, aggregate counts, and errors.

Verify Camps/Discover scrolling, sparse pages, refresh, and Camp switching
on devices. Monitor `digest:sweep` and `digest:sweep_failed` through the first
hourly cycle. Tests cover page bounds, age isolation, authorization overflow,
thumbnail safety, sparse-page continuation, and cursor checkpoints.

## Deferred work

The proposed retention rewrite was removed from this PR after review found
that it deleted Mux assets before rechecking thread eligibility. Retention
and archived-Camp cleanup need an atomic deletion claim, resumable child-row
cleanup, and retryable media deletion before that rewrite is ready.

Other remaining work includes paginating per-user device delivery, moderation
and admin aggregates, repair/reconciliation scans, and non-feed block-list
consumers. The legacy Camp wrapper and frozen/grace membership supplement
remain deliberately bounded; exceptionally large accounts need paginated
membership browsing.
