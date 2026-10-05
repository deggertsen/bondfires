import { equalSecret, MAX_SEGMENT_BYTES, MAX_SEGMENTS } from '../../../packages/media/src/protocol'

const BASE64_TABLE = Uint8Array.from(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  (c) => c.charCodeAt(0),
)

/**
 * Encode bytes to base64 without the per-chunk spread + giant string join that
 * previously pushed the Worker over the CPU limit. Writes into a preallocated
 * ASCII buffer and decodes once with the native TextDecoder.
 */
export function encodeBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4)
  let o = 0
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out[o++] = BASE64_TABLE[(n >> 18) & 63]
    out[o++] = BASE64_TABLE[(n >> 12) & 63]
    out[o++] = BASE64_TABLE[(n >> 6) & 63]
    out[o++] = BASE64_TABLE[n & 63]
  }
  const remaining = bytes.length - i
  if (remaining === 1) {
    const n = bytes[i] << 16
    out[o++] = BASE64_TABLE[(n >> 18) & 63]
    out[o++] = BASE64_TABLE[(n >> 12) & 63]
    out[o++] = 0x3d
    out[o++] = 0x3d
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out[o++] = BASE64_TABLE[(n >> 18) & 63]
    out[o++] = BASE64_TABLE[(n >> 12) & 63]
    out[o++] = BASE64_TABLE[(n >> 6) & 63]
    out[o++] = 0x3d
  }
  return new TextDecoder().decode(out.subarray(0, o))
}

/** Server-only, bounded transcription; video bytes never leave our Cloudflare account. */
export async function transcribeRequest(request: Request, env: Env): Promise<Response> {
  if (
    request.method !== 'POST' ||
    !(await equalSecret(
      request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
      env.MEDIA_WORKER_SECRET,
    ))
  )
    return new Response('Forbidden', { status: 403 })
  const length = Number(request.headers.get('content-length'))
  if (!length || length > 1024) return new Response('Invalid request', { status: 400 })
  const { recordingId, startIndex, endIndex } = await request.json<{
    recordingId: string
    startIndex: number
    endIndex: number
  }>()
  if (
    !/^[a-z0-9]+$/.test(recordingId) ||
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    startIndex < 0 ||
    endIndex <= startIndex ||
    endIndex > MAX_SEGMENTS ||
    endIndex - startIndex > 32
  )
    throw Error('Invalid transcription window')
  const names = [
    'init.mp4',
    ...Array.from(
      { length: endIndex - startIndex },
      (_, i) => `segment-${String(startIndex + i).padStart(6, '0')}.m4s`,
    ),
  ]
  const parts: Uint8Array[] = []
  let size = 0
  for (const name of names) {
    const object = await env.VIDEO.get(`${recordingId}/${name}`)
    if (!object || object.size > (name === 'init.mp4' ? 256 * 1024 : MAX_SEGMENT_BYTES))
      throw Error('Missing transcription media')
    size += object.size
    if (size > 12 * 1024 * 1024 + 256 * 1024) throw Error('Transcription window too large')
    parts.push(new Uint8Array(await object.arrayBuffer()))
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const audioBytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    audioBytes.set(part, offset)
    offset += part.length
  }
  const audio = encodeBase64(audioBytes)
  const result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
    audio,
    vad_filter: true,
    condition_on_previous_text: false,
  })
  // Return timing metadata only; never log private transcripts or media payloads.
  return Response.json({
    text: result.text,
    segments: result.segments ?? [],
    language: result.transcription_info?.language,
    duration: result.transcription_info?.duration,
  })
}
