import { putImmutable } from '../../../packages/media/src/immutableStorage'
import {
  equalSecret,
  MAX_SEGMENT_BYTES,
  verifyCapability,
} from '../../../packages/media/src/protocol'
import { mediaResponse } from './mediaResponse'

const publicFile =
  /^(index\.m3u8|init\.mp4|segment-\d{6}\.m4s|captions\.vtt|thumbnail\.jpg|preview\.gif)$/
const storedFile =
  /^(index\.m3u8|init\.mp4|segment-\d{6}\.m4s|captions\.vtt|thumbnail\.jpg|preview\.gif|manifest\.json|archive-\d{6}\.bin)$/
export async function importRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/imports\/([a-z0-9]+)(?:\/([^/]+))?$/)
  if (!match) return new Response('Not found', { status: 404 })
  const [, id, file] = match
  const admin = await equalSecret(
    request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
    env.MEDIA_WORKER_SECRET,
  )
  const prefix = `imports/${id}/`
  if (request.method === 'DELETE' && admin && !file) {
    let cursor: string | undefined
    do {
      const page = await env.VIDEO.list({ prefix, cursor, limit: 1000 })
      if (page.objects.length) await env.VIDEO.delete(page.objects.map((o) => o.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return new Response(null, { status: 204 })
  }
  if (!file || !storedFile.test(file)) return new Response('Not found', { status: 404 })
  const key = prefix + file
  if (request.method === 'PUT' && admin) {
    const length = Number(request.headers.get('content-length'))
    const digest = request.headers.get('x-content-sha256') ?? ''
    if (
      !request.body ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > MAX_SEGMENT_BYTES ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      return new Response('Invalid upload', { status: 400 })
    const body = request.body
    const stored = await putImmutable(
      digest,
      async () => {
        const object = await env.VIDEO.head(key)
        return object ? (object.customMetadata?.checksum ?? '') : null
      },
      () =>
        env.VIDEO.put(key, body, {
          sha256: Uint8Array.from(digest.match(/../g) ?? [], (hex) => Number.parseInt(hex, 16))
            .buffer,
          onlyIf: { etagDoesNotMatch: '*' },
          customMetadata: { checksum: digest },
        }),
    )
    if (!stored) return new Response('Immutable object conflict', { status: 409 })
    return new Response(null, { status: 204, headers: { 'x-content-sha256': digest } })
  }
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Forbidden', { status: 403 })
  let token = ''
  if (!admin) {
    if (!publicFile.test(file)) return new Response('Forbidden', { status: 403 })
    token = url.searchParams.get('token') ?? ''
    const claims = await verifyCapability(token, env.MEDIA_TOKEN_SECRET)
    if (claims.operation !== 'read' || claims.recordingId !== id)
      return new Response('Forbidden', { status: 403 })
    const access = await fetch(`${env.CONVEX_SITE_URL}/internal-media`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.MEDIA_WORKER_SECRET}`,
      },
      body: JSON.stringify({ operation: 'readImport', token }),
      signal: AbortSignal.timeout(15000),
    })
    if (!access.ok) return new Response('Forbidden', { status: access.status === 403 ? 403 : 503 })
    const { manifestChecksum } = (await access.json()) as { manifestChecksum: string }
    const manifest = await env.VIDEO.get(`${prefix}manifest.json`)
    if (
      !manifest ||
      manifest.size > MAX_SEGMENT_BYTES ||
      manifest.customMetadata?.checksum !== manifestChecksum
    )
      return new Response('Unavailable', { status: 503 })
    const contents = await manifest.json<{
      files: Record<string, { sha256: string; size: number }>
    }>()
    if (!Object.hasOwn(contents.files, file)) return new Response('Not found', { status: 404 })
  }
  const object = await env.VIDEO.get(key)
  if (!object) return new Response('Not found', { status: 404 })
  if (object.size > MAX_SEGMENT_BYTES) return new Response('Invalid media', { status: 503 })
  if (admin) {
    // Archive verification streams through R2, avoiding one buffer per concurrent upload/read.
    return new Response(request.method === 'HEAD' ? null : object.body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(object.size),
        'Cache-Control': 'private, no-store',
        'x-content-sha256': object.customMetadata?.checksum ?? '',
        ETag: object.httpEtag,
      },
    })
  }

  let bytes: Uint8Array = new Uint8Array(await object.arrayBuffer())
  if (file === 'index.m3u8' && !admin) {
    const query = `?token=${encodeURIComponent(token)}`
    const playlist = new TextDecoder()
      .decode(bytes)
      .replace(/URI="(init\.mp4)"/g, `URI="$1${query}"`)
      .replace(/^(segment-\d{6}\.m4s)$/gm, `$1${query}`)
    bytes = new TextEncoder().encode(playlist)
  }
  const response = mediaResponse(request, bytes, object.httpEtag)
  response.headers.set('x-content-sha256', object.customMetadata?.checksum ?? '')
  const type = file.endsWith('.m3u8')
    ? 'application/vnd.apple.mpegurl'
    : file.endsWith('.vtt')
      ? 'text/vtt; charset=utf-8'
      : file.endsWith('.jpg')
        ? 'image/jpeg'
        : file.endsWith('.gif')
          ? 'image/gif'
          : file.endsWith('.json')
            ? 'application/json'
            : 'video/mp4'
  response.headers.set('Content-Type', type)
  return response
}
