import {
  InvalidSegmentDuration,
  inspectInit,
  inspectSegment,
  normalizeAacSampleFlags,
  repairSingleSampleDuration,
  type Track,
} from '../../../packages/media/src/mp4'
import {
  buildPlaylist,
  equalSecret,
  MAX_SEGMENT_BYTES,
  MAX_SEGMENTS,
  type MediaSegment,
  SEGMENT_NAME,
  verifyCapability,
} from '../../../packages/media/src/protocol'
import { mediaResponse } from './mediaResponse'

async function readBounded(request: Request): Promise<Uint8Array> {
  const length = Number(request.headers.get('content-length'))
  if (!request.body || !Number.isSafeInteger(length) || length <= 0 || length > MAX_SEGMENT_BYTES)
    throw new Error('Invalid upload size')
  const reader = request.body.getReader()
  const timeout = setTimeout(() => {
    void reader.cancel()
  }, 60_000)
  const result = new Uint8Array(length)
  let offset = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.length > length) throw new Error('Upload exceeds declared size')
      result.set(value, offset)
      offset += value.length
    }
  } finally {
    clearTimeout(timeout)
    await reader.cancel()
    reader.releaseLock()
  }
  if (offset !== length) throw new Error('Incomplete upload')
  return result
}
async function backend(env: Env, body: Record<string, unknown>) {
  const response = await fetch(`${env.CONVEX_SITE_URL}/internal-media`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MEDIA_WORKER_SECRET}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok)
    throw new Error(
      response.status === 403 || response.status === 404
        ? 'Forbidden'
        : 'Media service unavailable',
    )
  return response.json() as Promise<{ complete: boolean; segments: MediaSegment[] }>
}
/** Preserve immutable uploaded bytes/checksums; normalize only validation and delivery. */
async function normalizeTiming(
  env: Env,
  recordingId: string,
  index: number,
  bytes: Uint8Array,
  tracks: readonly Track[],
) {
  try {
    inspectSegment(bytes, tracks)
    return bytes
  } catch (error) {
    if (!(error instanceof InvalidSegmentDuration) || error.duration !== 0 || index <= 0)
      throw error
    const previous = await env.VIDEO.get(
      `${recordingId}/segment-${String(index - 1).padStart(6, '0')}.m4s`,
    )
    if (!previous || previous.size > MAX_SEGMENT_BYTES) throw error
    return repairSingleSampleDuration(bytes, tracks, new Uint8Array(await previous.arrayBuffer()))
  }
}
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ environment: 'internal', version: 1 })
    try {
      const deletion = /^\/v1\/([a-z0-9]+)$/.exec(url.pathname)
      if (deletion && request.method === 'DELETE') {
        if (
          !(await equalSecret(
            request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
            env.MEDIA_WORKER_SECRET,
          ))
        )
          throw new Error('Forbidden')
        let cursor: string | undefined
        do {
          const page = await env.VIDEO.list({ prefix: `${deletion[1]}/`, limit: 1000, cursor })
          if (page.objects.length) await env.VIDEO.delete(page.objects.map((object) => object.key))
          cursor = page.truncated ? page.cursor : undefined
        } while (cursor)
        return new Response(null, { status: 204 })
      }
      const match = /^\/v1\/([a-z0-9]+)\/(init\.mp4|segment-\d{6}\.m4s|index\.m3u8)$/.exec(
        url.pathname,
      )
      if (!match) return new Response('Not found', { status: 404 })
      const [, recordingId, filename] = match
      const token =
        url.searchParams.get('token') ??
        request.headers.get('authorization')?.replace(/^Bearer /, '') ??
        ''
      const claims = await verifyCapability(token, env.MEDIA_TOKEN_SECRET)
      if (claims.recordingId !== recordingId) throw new Error('Forbidden')
      const key = `${recordingId}/${filename}`
      const index = filename === 'init.mp4' ? -1 : Number(SEGMENT_NAME.exec(filename)?.[1])
      if (request.method === 'PUT') {
        if (claims.operation !== 'upload' || filename === 'index.m3u8' || index >= MAX_SEGMENTS)
          throw new Error('Forbidden')
        // Authorize again before storage, including cancelled/deleted recordings.
        await backend(env, { operation: 'authorizeUpload', token, index })
        const bytes = await readBounded(request)
        let duration = 0
        if (index === -1) inspectInit(bytes)
        else {
          const init = await env.VIDEO.get(`${recordingId}/init.mp4`)
          if (!init) return new Response('Upload initialization first', { status: 409 })
          try {
            const tracks = inspectInit(new Uint8Array(await init.arrayBuffer()))
            const normalized = await normalizeTiming(env, recordingId, index, bytes, tracks)
            duration = inspectSegment(normalized, tracks)
          } catch (error) {
            // Structural diagnostics only: never persist rejected media or log
            // request URLs, capabilities, payload bytes, or raw network errors.
            console.warn(
              JSON.stringify({
                event: 'media_segment_rejected',
                recordingId,
                index,
                size: bytes.length,
                reason: error instanceof InvalidSegmentDuration ? 'duration' : 'invalid_mp4',
                duration: error instanceof InvalidSegmentDuration ? error.duration : undefined,
              }),
            )
            throw error
          }
        }
        const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).reduce(
          (s, b) => s + b.toString(16).padStart(2, '0'),
          '',
        )
        const existing = await env.VIDEO.head(key)
        if (existing && existing.customMetadata?.sha256 !== checksum)
          return new Response('Segment conflict', { status: 409 })
        if (!existing) {
          const stored = await env.VIDEO.put(key, bytes, {
            onlyIf: { etagDoesNotMatch: '*' },
            httpMetadata: { contentType: 'video/mp4' },
            customMetadata: { sha256: checksum },
          })
          if (!stored) {
            const concurrent = await env.VIDEO.head(key)
            if (concurrent?.customMetadata?.sha256 !== checksum)
              return new Response('Segment conflict', { status: 409 })
          }
        }
        await backend(env, {
          operation: 'receipt',
          token,
          index,
          duration,
          size: bytes.length,
          checksum,
        })
        return new Response(null, { status: 204 })
      }
      if (!['GET', 'HEAD'].includes(request.method) || claims.operation !== 'read')
        throw new Error('Forbidden')
      // Membership, moderation and deletion are checked even for cached capabilities.
      const state = await backend(env, {
        operation: 'read',
        token,
        index: filename === 'index.m3u8' ? null : index,
      })
      if (filename === 'index.m3u8') {
        if (!state.segments.length)
          return new Response('Preparing video', { status: 503, headers: { 'Retry-After': '2' } })
        return new Response(
          request.method === 'HEAD' ? null : buildPlaylist(state.segments, state.complete, token),
          {
            headers: {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Cache-Control': 'no-store',
            },
          },
        )
      }
      if (filename !== 'init.mp4') {
        // Complete fragments are bounded on ingest. Normalize before applying
        // ranges so old recordings work without rewriting immutable R2 objects.
        const object = await env.VIDEO.get(key)
        if (!object) return new Response('Not found', { status: 404 })
        if (object.size > MAX_SEGMENT_BYTES) throw new Error('Segment too large')
        const init = await env.VIDEO.get(`${recordingId}/init.mp4`)
        if (!init || init.size > 256 * 1024) throw new Error('Invalid initialization')
        const tracks = inspectInit(new Uint8Array(await init.arrayBuffer()))
        const timed = await normalizeTiming(
          env,
          recordingId,
          index,
          new Uint8Array(await object.arrayBuffer()),
          tracks,
        )
        const bytes = normalizeAacSampleFlags(timed, tracks)
        return mediaResponse(request, bytes, `"sample-timing-v2-${object.etag}"`)
      }
      const object = await env.VIDEO.get(key, { range: request.headers })
      if (!object) return new Response('Not found', { status: 404 })
      const headers = new Headers({
        'Content-Type': 'video/mp4',
        'Cache-Control': 'private, no-store',
        'Accept-Ranges': 'bytes',
        ETag: object.httpEtag,
      })
      let status = 200
      if (
        object.range &&
        'offset' in object.range &&
        typeof object.range.offset === 'number' &&
        'length' in object.range &&
        typeof object.range.length === 'number'
      ) {
        const { offset, length } = object.range
        headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
        headers.set('Content-Length', String(length))
        status = 206
      } else headers.set('Content-Length', String(object.size))
      return new Response(request.method === 'HEAD' ? null : object.body, { status, headers })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Media request failed'
      const status =
        message === 'Forbidden' || message === 'Invalid token'
          ? 403
          : message === 'Media service unavailable'
            ? 503
            : 400
      // Never log request URLs: playback capabilities are bearer credentials.
      console.warn(JSON.stringify({ event: 'media_request_failed', status }))
      return new Response(status === 503 ? 'Try again' : 'Media request rejected', { status })
    }
  },
} satisfies ExportedHandler<Env>
