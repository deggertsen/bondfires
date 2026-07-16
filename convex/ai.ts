import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { buildMuxTranscriptUrl } from './videos'

/**
 * AI thread insights: Mux auto-generated captions → per-video summary + tags,
 * plus an LLM-written title for the whole thread.
 *
 * Flow: video.asset.track.ready webhook (videos.ts) schedules
 * processVideoTranscript → fetch transcript text from stream.mux.com → one
 * OpenRouter call for {summary, tags} → patch the video record → regenerate
 * the thread title from all summaries. Transcript text is stored in the
 * videoTranscripts table so it never rides along in feed queries.
 *
 * Uses a cheap OpenRouter model (default z-ai/glm-4.5-air), deliberately not
 * the Anthropic API: this runs once per uploaded video, so per-call price
 * dominates. Model is swappable via OPENROUTER_MODEL.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_OPENROUTER_MODEL = 'z-ai/glm-4.5-air'
const OPENROUTER_TIMEOUT_MS = 60_000
// Mux serves the transcript from its CDN; right after track.ready it can 404
// briefly, so failed fetches reschedule instead of dying.
const TRANSCRIPT_FETCH_MAX_ATTEMPTS = 5
const TRANSCRIPT_FETCH_RETRY_DELAY_MS = 30_000
// ~10 minutes of speech. Longer videos are summarized from the head; the tail
// of a rambling video rarely changes the one-line summary.
const MAX_TRANSCRIPT_CHARS = 16_000
const MAX_SUMMARY_CHARS = 120
const MAX_TAGS = 3
const MAX_TAG_CHARS = 24
const MAX_TITLE_CHARS = 48
// Below this the video is effectively silent — a summary would be noise.
const MIN_TRANSCRIPT_CHARS = 20

const recordTable = v.union(v.literal('bondfires'), v.literal('bondfireVideos'))
const recordId = v.union(v.id('bondfires'), v.id('bondfireVideos'))

type RecordTable = 'bondfires' | 'bondfireVideos'
type RecordId = Id<'bondfires'> | Id<'bondfireVideos'>

function getOpenRouterConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error(
      'OpenRouter is not configured. Set OPENROUTER_API_KEY (and optionally OPENROUTER_MODEL) in Convex environment variables.',
    )
  }

  return { apiKey, model: process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL }
}

async function callOpenRouterJson(
  prompt: string,
  maxTokens: number,
): Promise<Record<string, unknown>> {
  const { apiKey, model } = getOpenRouterConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS)
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Bondfires',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: maxTokens,
        // GLM-class models default to hybrid "thinking"; this is a short
        // formatting task where reasoning tokens only add cost and latency.
        reasoning: { enabled: false },
        response_format: { type: 'json_object' },
      }),
    })

    if (!response.ok) {
      const message = await response.text()
      throw new Error(`OpenRouter request failed: ${response.status} ${message}`)
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('OpenRouter response had no message content')
    }

    return extractJsonObject(content)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`OpenRouter request timed out after ${OPENROUTER_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Providers occasionally wrap JSON in code fences or prose despite
 * response_format; parse the outermost object substring instead of trusting
 * the raw content.
 */
function extractJsonObject(content: string): Record<string, unknown> {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(`LLM response contained no JSON object: ${content.slice(0, 200)}`)
  }

  const parsed: unknown = JSON.parse(content.slice(start, end + 1))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('LLM response JSON was not an object')
  }

  return parsed as Record<string, unknown>
}

function cleanSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const summary = value.replace(/\s+/g, ' ').trim()
  if (!summary) return undefined
  return summary.length > MAX_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : summary
}

function cleanTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags = value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag.length <= MAX_TAG_CHARS)
    // "1-2 words" is a prompt rule; enforce it so a misbehaving model can't
    // push paragraph-length chips into the UI.
    .filter((tag) => tag.split(' ').length <= 2)
  const unique = [...new Set(tags)].slice(0, MAX_TAGS)
  return unique.length > 0 ? unique : undefined
}

function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”.!]+$/g, '')
  if (!title) return undefined
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title
}

function videoInsightsPrompt(transcript: string): string {
  return [
    'You summarize short personal video messages exchanged between close friends and family.',
    '',
    'Transcript of one video message:',
    '"""',
    transcript,
    '"""',
    '',
    'Reply with ONLY a JSON object in this exact shape:',
    `{"summary": "<one sentence, max ${MAX_SUMMARY_CHARS} characters>", "tags": ["<topic tag>"]}`,
    '',
    'Rules:',
    '- summary: third person, present tense, concrete ("Shares news about the new job and asks about the kids"), no preamble, no speaker names.',
    `- tags: 1 to ${MAX_TAGS} tags, each 1-2 lowercase words naming concrete topics (e.g. "job news", "birthday", "soccer"). Never generic filler like "update", "chat", or "video".`,
  ].join('\n')
}

function threadTitlePrompt(items: Array<{ creatorName: string; summary: string }>): string {
  const lines = items.map((item, index) => `${index + 1}. ${item.creatorName}: ${item.summary}`)
  return [
    'These are the video messages of one ongoing thread between close friends and family, in order:',
    '',
    ...lines,
    '',
    'Reply with ONLY a JSON object in this exact shape:',
    '{"title": "<thread title>"}',
    '',
    'Rules:',
    '- 2 to 6 words capturing what the thread is about, like a conversation subject line.',
    '- No ending punctuation, no quotes, no emoji, no participant names unless essential.',
  ].join('\n')
}

export const getRecordForInsights = internalQuery({
  args: { table: recordTable, recordId },
  handler: async (ctx, args) => {
    if (args.table === 'bondfires') {
      const document = await ctx.db.get(args.recordId as Id<'bondfires'>)
      if (!document) return null
      return {
        muxPlaybackId: document.muxPlaybackId,
        muxPlaybackPolicy: document.muxPlaybackPolicy,
        summary: document.summary,
        bondfireId: document._id,
      }
    }

    const document = await ctx.db.get(args.recordId as Id<'bondfireVideos'>)
    if (!document) return null
    return {
      muxPlaybackId: document.muxPlaybackId,
      muxPlaybackPolicy: document.muxPlaybackPolicy,
      summary: document.summary,
      bondfireId: document.bondfireId,
    }
  },
})

async function findTranscriptRow(ctx: QueryCtx, table: RecordTable, id: RecordId) {
  return table === 'bondfires'
    ? await ctx.db
        .query('videoTranscripts')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', id as Id<'bondfires'>))
        .first()
    : await ctx.db
        .query('videoTranscripts')
        .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', id as Id<'bondfireVideos'>))
        .first()
}

export const getStoredTranscript = internalQuery({
  args: { table: recordTable, recordId },
  handler: async (ctx, args) => {
    const row = await findTranscriptRow(ctx, args.table, args.recordId)
    return row ? { text: row.text } : null
  },
})

export const saveTranscript = internalMutation({
  args: {
    table: recordTable,
    recordId,
    muxAssetId: v.string(),
    muxTrackId: v.optional(v.string()),
    languageCode: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await findTranscriptRow(ctx, args.table, args.recordId)

    const fields = {
      muxAssetId: args.muxAssetId,
      muxTrackId: args.muxTrackId,
      languageCode: args.languageCode,
      text: args.text,
    }

    if (existing) {
      await ctx.db.patch(existing._id, fields)
      return existing._id
    }

    return await ctx.db.insert('videoTranscripts', {
      ...fields,
      bondfireId: args.table === 'bondfires' ? (args.recordId as Id<'bondfires'>) : undefined,
      bondfireVideoId:
        args.table === 'bondfireVideos' ? (args.recordId as Id<'bondfireVideos'>) : undefined,
      createdAt: Date.now(),
    })
  },
})

export const saveVideoInsights = internalMutation({
  args: {
    table: recordTable,
    recordId,
    summary: v.optional(v.string()),
    aiTags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const id = args.recordId as Id<'bondfires'> & Id<'bondfireVideos'>
    const document = await ctx.db.get(id)
    if (!document) return

    // Patching an explicit undefined would DELETE the field — a partial LLM
    // result (tags without summary) must not clear a previously saved value.
    const fields: { summary?: string; aiTags?: string[] } = {}
    if (args.summary !== undefined) fields.summary = args.summary
    if (args.aiTags !== undefined) fields.aiTags = args.aiTags

    if (args.table === 'bondfires') {
      await ctx.db.patch(id as Id<'bondfires'>, { ...fields, updatedAt: Date.now() })
    } else {
      await ctx.db.patch(id as Id<'bondfireVideos'>, fields)
    }
  },
})

export const saveThreadTitle = internalMutation({
  args: { bondfireId: v.id('bondfires'), aiTitle: v.string() },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) return

    await ctx.db.patch(args.bondfireId, { aiTitle: args.aiTitle, updatedAt: Date.now() })
  },
})

export const getThreadDigest = internalQuery({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) return null

    const videos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .order('asc')
      .collect()

    const items: Array<{ creatorName: string; summary: string }> = []
    if (bondfire.summary) {
      items.push({ creatorName: bondfire.creatorName ?? 'Someone', summary: bondfire.summary })
    }
    for (const video of videos) {
      if (video.summary) {
        items.push({ creatorName: video.creatorName ?? 'Someone', summary: video.summary })
      }
    }

    return { hasUserTitle: Boolean(bondfire.title), items }
  },
})

/**
 * Delete transcript rows whose parent video record is gone. Bondfire/response
 * deletion is spread across many cascades (retention, failure cleanup, user
 * deletes, camp cleanup); rather than threading transcript cleanup through
 * every one, this daily sweep — in the spirit of the repo's reconciliation
 * crons — keeps deleted videos' transcript text from outliving them.
 */
export const sweepOrphanedTranscripts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('videoTranscripts').collect()
    let deleted = 0
    for (const row of rows) {
      const parentId = row.bondfireId ?? row.bondfireVideoId
      const parent = parentId ? await ctx.db.get(parentId) : null
      if (!parent) {
        await ctx.db.delete(row._id)
        deleted++
      }
    }
    return { scanned: rows.length, deleted }
  },
})

/**
 * Ready videos that never got AI insights — feeds backfillVideoInsights
 * (videos.ts). Manual/maintenance path, so a bounded scan is fine.
 */
export const listRecordsMissingInsights = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 25, 1), 100)
    const scanCap = 500

    const [bondfires, responses] = await Promise.all([
      ctx.db
        .query('bondfires')
        .withIndex('by_video_status', (q) => q.eq('videoStatus', 'ready'))
        .order('desc')
        .take(scanCap),
      ctx.db
        .query('bondfireVideos')
        .withIndex('by_video_status', (q) => q.eq('videoStatus', 'ready'))
        .order('desc')
        .take(scanCap),
    ])

    const candidates = [
      ...bondfires.map((doc) => ({ table: 'bondfires' as const, doc })),
      ...responses.map((doc) => ({ table: 'bondfireVideos' as const, doc })),
    ].filter(({ doc }) => doc.summary === undefined && doc.muxAssetId !== undefined)

    const results: Array<{
      table: RecordTable
      recordId: RecordId
      muxAssetId: string
      hasTranscript: boolean
    }> = []
    for (const { table, doc } of candidates.slice(0, limit)) {
      const transcript = await findTranscriptRow(ctx, table, doc._id)
      results.push({
        table,
        recordId: doc._id,
        muxAssetId: doc.muxAssetId as string,
        hasTranscript: transcript !== null,
      })
    }
    return results
  },
})

/**
 * Fetch a video's transcript and turn it into a one-line summary and topic
 * tags, then refresh the thread's AI title. Scheduled from the
 * video.asset.track.ready webhook; also the workhorse for backfill (when a
 * stored transcript already exists the Mux fetch is skipped, so muxTrackId is
 * optional).
 */
export const processVideoTranscript = internalAction({
  args: {
    table: recordTable,
    recordId,
    muxAssetId: v.string(),
    muxTrackId: v.optional(v.string()),
    languageCode: v.optional(v.string()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const record = await ctx.runQuery(internal.ai.getRecordForInsights, {
      table: args.table,
      recordId: args.recordId,
    })
    if (!record) {
      return { processed: false, reason: 'record_not_found' }
    }

    let transcript = (
      await ctx.runQuery(internal.ai.getStoredTranscript, {
        table: args.table,
        recordId: args.recordId,
      })
    )?.text

    if (transcript === undefined) {
      if (!record.muxPlaybackId && args.muxTrackId) {
        // track.ready can race ahead of asset.ready, in which case the record
        // has a muxAssetId (patched at upload.asset_created) but no playback
        // ID yet. Retry on the same cadence as CDN propagation.
        const attempt = args.attempt ?? 0
        if (attempt + 1 < TRANSCRIPT_FETCH_MAX_ATTEMPTS) {
          await ctx.scheduler.runAfter(
            TRANSCRIPT_FETCH_RETRY_DELAY_MS,
            internal.ai.processVideoTranscript,
            { ...args, attempt: attempt + 1 },
          )
          return { processed: false, reason: 'awaiting_playback_id' }
        }
      }

      if (!record.muxPlaybackId || !args.muxTrackId) {
        console.error('ai:transcript:missing_playback_or_track', {
          table: args.table,
          recordId: args.recordId,
          muxAssetId: args.muxAssetId,
        })
        return { processed: false, reason: 'missing_playback_or_track' }
      }

      const url = await buildMuxTranscriptUrl({
        playbackId: record.muxPlaybackId,
        trackId: args.muxTrackId,
        playbackPolicy: record.muxPlaybackPolicy,
      })
      const response = await fetch(url)
      if (!response.ok) {
        const attempt = args.attempt ?? 0
        if (attempt + 1 < TRANSCRIPT_FETCH_MAX_ATTEMPTS) {
          await ctx.scheduler.runAfter(
            TRANSCRIPT_FETCH_RETRY_DELAY_MS,
            internal.ai.processVideoTranscript,
            { ...args, attempt: attempt + 1 },
          )
          return { processed: false, reason: 'transcript_fetch_retrying' }
        }
        throw new Error(
          `Transcript fetch failed after ${TRANSCRIPT_FETCH_MAX_ATTEMPTS} attempts: ${response.status} ${url}`,
        )
      }

      transcript = (await response.text()).trim().slice(0, MAX_TRANSCRIPT_CHARS)
      await ctx.runMutation(internal.ai.saveTranscript, {
        table: args.table,
        recordId: args.recordId,
        muxAssetId: args.muxAssetId,
        muxTrackId: args.muxTrackId,
        languageCode: args.languageCode,
        text: transcript,
      })
    }

    if (transcript.length < MIN_TRANSCRIPT_CHARS) {
      return { processed: false, reason: 'transcript_too_short' }
    }

    const raw = await callOpenRouterJson(videoInsightsPrompt(transcript), 300)
    const summary = cleanSummary(raw.summary)
    const aiTags = cleanTags(raw.tags)
    if (!summary && !aiTags) {
      throw new Error(`LLM returned neither summary nor tags: ${JSON.stringify(raw).slice(0, 200)}`)
    }

    await ctx.runMutation(internal.ai.saveVideoInsights, {
      table: args.table,
      recordId: args.recordId,
      summary,
      aiTags,
    })

    await ctx.scheduler.runAfter(0, internal.ai.generateThreadTitle, {
      bondfireId: record.bondfireId,
    })
    return { processed: true }
  },
})

/**
 * Write/refresh the thread's AI title from all per-video summaries. Runs after
 * every processed video so the title tracks the conversation as it grows.
 * Skipped when the creator set a title themselves — the UI prefers the user
 * title anyway, so the LLM call would be wasted.
 */
export const generateThreadTitle = internalAction({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const digest = await ctx.runQuery(internal.ai.getThreadDigest, {
      bondfireId: args.bondfireId,
    })
    if (!digest || digest.hasUserTitle || digest.items.length === 0) {
      return { generated: false }
    }

    const raw = await callOpenRouterJson(threadTitlePrompt(digest.items), 100)
    const title = cleanTitle(raw.title)
    if (!title) {
      throw new Error(`LLM returned no usable title: ${JSON.stringify(raw).slice(0, 200)}`)
    }

    await ctx.runMutation(internal.ai.saveThreadTitle, {
      bondfireId: args.bondfireId,
      aiTitle: title,
    })
    return { generated: true, title }
  },
})
