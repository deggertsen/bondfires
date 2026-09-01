# Account deletion

Bondfires treats an in-app deletion request as an immediate account closure and
an asynchronous data-erasure request. The client is signed out immediately;
the backend keeps only a restricted deletion tombstone while the workflow runs.

## Workflow and failure safety

1. `accountDeletion.request` creates one idempotent job, marks the user as
   deleting, revokes every auth session, and schedules the worker.
2. The inventory phase pages through the user's Bondfires, responses, and live
   sessions in batches of 25. Child responses are inventoried separately.
3. Every Mux direct-upload, asset, and live-stream ID is copied into a durable
   work queue. Direct uploads are canceled first so an upload already running
   on the device cannot create a new asset behind the inventory snapshot. If
   the upload wins that race, the worker resolves and deletes its new asset.
4. Mux resources are deleted in small batches. A 404 counts as success. Other
   failures retain the database pointers and retry with capped exponential
   backoff. An hourly cron recovers interrupted scheduler deliveries.
5. Only after every Mux target is deleted or confirmed absent does database
   cleanup begin. Related transcripts, reactions, reports, analytics, invites,
   presence, and live-session rows are removed in bounded batches before their
   parent video row. Thread-level notifications are removed only when their
   parent Bondfire is deleted, never when a single participant deletes a
   response.
6. Public camps are transferred to an active moderator, then an active member.
   If there is no successor, a user-created camp is archived; a launch camp is
   left active without a user owner for administrator reassignment. Hearths and
   their owner's Bondfires are deleted.
7. The profile image is deleted from Convex storage, the user/auth records are
   removed, and the non-identifying job is marked complete.

The invariant is: **no Bondfires database pointer is removed before the
external Mux resource it identifies has been deleted or confirmed absent**.

## Retention decisions

Deleted immediately:

- Profile, profile photo, authentication accounts/sessions/codes.
- Videos, Mux assets/live streams, captions/transcripts, local device backups.
- Camp memberships, Hearths, invitations/claims, notifications, presence,
  reactions, watch history, pins, client logs, reports, and audit rows that
  directly identify the user.
- Kindling ledger entries and reconciliation records tied to the user.

Retained without a Bondfires user/profile reference:

- App Store and Google Play transaction/original-transaction/purchase-token
  identifiers, product, platform, source, and deletion timestamp. These are
  retained for receipt-replay prevention, refunds, charge disputes, fraud
  prevention, and financial recordkeeping. They cannot recreate a profile and
  are checked before a receipt can be linked to a future account.
- The deletion job ID, timestamps, terminal status, attempt count, and final
  operational error. The user reference and profile-storage pointer are erased
  at completion.

The Privacy Policy and deletion-request page must disclose the financial record
exception and its legal/business retention period. Product/legal must set that
period and add a purge policy if indefinite retention is not justified.

## Subscriptions

Deleting a Bondfires account does **not** cancel a subscription managed by Apple
or Google. The confirmation UI says this explicitly and directs the user to the
store's subscription management. Bondfires removes the entitlement and user
association while retaining only the transaction identifiers described above.

## Operational response

`retrying` is expected during temporary Mux or storage outages; the account
remains inaccessible and its pointers remain intact. Alert on jobs that remain
non-terminal for 24 hours. Investigate Mux credentials/provider status, then
allow the scheduled retry to continue—do not manually delete queue rows or the
user record.

## Owner decisions still required

- Counsel-approved retention period for anonymized store transaction records.
- Whether child-safety evidence that is subject to a legal preservation hold
  must be moved to a separate restricted evidence system before normal report
  rows are erased. This workflow currently deletes application report rows.
- User-facing deletion completion/SLA language for the website and Privacy
  Policy. The app deliberately promises background processing, not instant
  completion.

## Store-policy references

- [Apple: Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [Google Play: Account deletion requirement](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Mux: Cancel a direct upload](https://www.mux.com/docs/api-reference/video/direct-uploads/cancel-direct-upload)
