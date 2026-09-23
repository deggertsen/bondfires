import { equalSecret, MAX_SEGMENT_BYTES, MAX_SEGMENTS } from '../../../packages/media/src/protocol'

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
  const binary: string[] = []
  for (const part of parts)
    for (let i = 0; i < part.length; i += 8192)
      binary.push(String.fromCharCode(...part.subarray(i, i + 8192)))
  const audio = btoa(binary.join(''))
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
