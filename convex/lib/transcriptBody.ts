import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

type ReadCtx = QueryCtx | MutationCtx

/** Legacy rows keep text inline until a sweep or the next chunk moves it. */
export function transcriptBodyExternal(row: Doc<'videoTranscripts'>) {
  return row.textChars !== undefined
}

export async function readTranscriptBody(ctx: ReadCtx, row: Doc<'videoTranscripts'>) {
  if (!transcriptBodyExternal(row)) return { text: row.text, captionsVtt: row.captionsVtt }
  const chunks = await ctx.db
    .query('transcriptChunks')
    .withIndex('by_transcript_cursor', (q) => q.eq('transcriptId', row._id))
    .collect()
  let text = ''
  let captionsVtt = ''
  for (const chunk of chunks) {
    text = `${text}${chunk.text ? ` ${chunk.text}` : ''}`.trim()
    captionsVtt += chunk.vtt
  }
  return { text, captionsVtt: captionsVtt || undefined }
}

/** Chunk rows are not visible to the orphan sweep, so deletion has to remove them. */
export async function deleteTranscriptChunks(
  ctx: MutationCtx,
  transcriptId: Id<'videoTranscripts'>,
) {
  while (true) {
    const page = await ctx.db
      .query('transcriptChunks')
      .withIndex('by_transcript_cursor', (q) => q.eq('transcriptId', transcriptId))
      .take(64)
    if (!page.length) return
    for (const chunk of page) await ctx.db.delete(chunk._id)
    if (page.length < 64) return
  }
}
