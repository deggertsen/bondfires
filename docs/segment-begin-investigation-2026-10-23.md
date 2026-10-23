# Stuck segment begin: investigation blocked on missing exception or journal arguments

This investigation does **not** establish a fix for localId
`81c4dd54-083b-45bf-945a-559801f91c19`. No application behavior was changed.
The original throwing line and the journal's destination arguments remain unknown.
Do not treat the passing baseline tests as a reproduction of this incident.

## Read-only production findings

Checked production deployment `ideal-akita-27` on October 23, 2026:

- A read-only inline query of `segmentRecordings`, filtered by the exact localId,
  returned `[]`. There is still no recording row to cancel.
- Requests to `/api/stream_function_logs` with cursors for October 21 00:00 UTC
  and October 22 23:55 UTC returned newer retained events. A subsequent traversal
  from cursor zero read 1,001 events spanning October 23 18:48:31.848–21:30:47.038
  UTC. Neither the localId, request `4e09a58b3da8b4f5`, nor the
  `[segmentMedia:begin] unexpected error` diagnostic occurred in those events.
  This is a retention gap, not evidence that the mutation did not throw.
- Reading the current deployed source through `/api/get_config` confirmed that
  `segmentMedia.js` imports `_deps/2KUJCNGL.js`, which contains #270's
  `[segmentMedia:begin] unexpected error` wrapper, ConvexError passthrough, and
  `Could not start this upload. It will retry.` fallback. The deployed validator
  also accepts `draftBondfireId: null`. This proves the code is deployed **now**;
  it does not establish when it first became active.
- The affected account has 274 retained `console:error` events mentioning
  `segmentMedia:begin`. The first contains request `4e09a58b3da8b4f5`; the last
  contains request `2bd6021be09bafb3`. Both contain only `Server Error` and identify
  app version `1.0.103 (119)`.
- The account has 12 retained `segment:upload:paused` events for this localId.
  They contain `stage: begin`, `nextIndex: -1`, and `code: [Redacted]`; they contain
  no destination IDs or original exception. Six of these events have client
  timestamps on October 21–22. Client `createdAt` and server `_creationTime` are
  distinct timestamps; use request IDs when correlating server logs.
- Five other retained recordings for this account are ready. All five are
  responses to the same Hearth thread, with response sequence numbers 1, 3, 4,
  6, and 8. This does not identify the failed journal's destination.

No production mutation, data insert, patch, delete, or Convex deployment was run.
The failed journal was not replayed against production.

## Why #270 does not stop the installed phone

Version 1.0.103 has the old retry loop. #270's client backoff starts at four seconds
and caps at five minutes, but requires a newer installed client. Changing an error
to ConvexError does not make this old journal terminal: the phone still retries
every thrown begin call. Only a successful normal begin response sets its
`recordingId`. Without a server row, server-side cancellation cannot stop it.

The server fix must make the affected input class return
`{ recordingId, recordId, maxDuration }`, or evidence must establish that these
particular journal arguments are permanently illegal. A future client may then
stop that specific permanent failure durably and emit one paused event. Neither
condition has been established here. Treating generic `Server Error` as terminal
would discard recoverable recordings without evidence.

## Required evidence to unblock the fix

Obtain either:

1. An archived backend exception, including its stack and request ID, for this
   localId; or
2. The saved journal's begin arguments: `isResponse`, `bondfireId`, `campId`,
   `personalCamp`, `draftBondfireId`, and `tags`. Preserve absent versus null values.

If the phone naturally retries again, capture the deployed #270 diagnostic before
it rotates out. The log stream can be observed without invoking begin:

```sh
yarn convex logs --prod --history --jsonl
```

Use an authorized production credential scoped to that command; never include it
in a report. If `CONVEX_DEPLOY_KEY` is set, it selects the deployment even with
`--prod`. Verify the target before reading.

Recheck the row without writing:

```sh
yarn convex run --prod --inline-query 'await ctx.db.query("segmentRecordings").filter(q => q.eq(q.field("localId"), "81c4dd54-083b-45bf-945a-559801f91c19")).collect()'
```

Once the arguments or exception are available, create a synthetic Convex fixture
that reproduces the named throwing line on `origin/main`. Verify the failure before
changing code, then verify success and idempotency after the fix. Preserve expected
ConvexErrors, unexpected-error logging, and transaction rollback. Do not add more
backoff or deploy as part of this investigation.

## Verification

The baseline `yarn vitest run convex/segmentMedia.test.ts
apps/mobile/test/segmentUploads.test.ts` passed all 64 tests, including success,
retry, diagnostics, rollback, and idempotency coverage. These are existing tests,
not an incident regression test. Full validation results are recorded in the draft
PR.
