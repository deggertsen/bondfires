import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/** Atomically queue private media deletion when its destination is removed. */
export async function cancelSegmentMedia(
  ctx: MutationCtx,
  video: { segmentRecordingId?: Id<'segmentRecordings'> },
) {
  if (!video.segmentRecordingId) return
  const recording = await ctx.db.get(video.segmentRecordingId)
  // Preserve the first cancellation time: purge keeps a tombstone for an hour
  // while already-authorized uploads settle and R2 deletion is retried.
  if (recording && recording.status !== 'cancelled')
    await ctx.db.patch(recording._id, { status: 'cancelled', updatedAt: Date.now() })
}
