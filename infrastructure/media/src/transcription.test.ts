import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  normalizeTranscriptionFailure,
  readMediaProbe,
  readTranscriptionFailureResponse,
  TranscriptionError,
} from '../../../packages/media/src/transcription'
import { encodeBase64, transcribeRequest } from './transcription'

describe('encodeBase64', () => {
  it('matches Buffer for empty input', () => {
    const bytes = new Uint8Array()
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('matches Buffer for %i bytes and its padding', (length) => {
    const bytes = Uint8Array.from({ length }, (_, i) => i + 1)
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })

  it.each([126, 127, 128])('matches Buffer for %i high-bit bytes', (length) => {
    const bytes = Uint8Array.from({ length }, (_, i) => 255 - i)
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })

  it('matches Buffer for many randomized lengths and byte values', () => {
    // Fixed seed keeps failures reproducible; use the upper bits for byte values.
    let seed = 0x12345678
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    for (let sample = 0; sample < 256; sample++) {
      const length = (next() >>> 16) % 16384
      const bytes = Uint8Array.from({ length }, () => next() >>> 24)
      expect(encodeBase64(bytes), `sample ${sample}, length ${length}`).toBe(
        Buffer.from(bytes).toString('base64'),
      )
    }
  })

  it.each([{ lengths: [1, 1, 4] }, { lengths: [2, 2, 3] }, { lengths: [1, 4, 3] }])(
    'matches Buffer for concatenated parts of lengths $lengths splitting three-byte groups',
    ({ lengths }) => {
      const parts = lengths.map((length, index) =>
        Uint8Array.from({ length }, (_, i) => (index * 83 + i * 47) % 256),
      )
      const bytes = new Uint8Array(lengths.reduce((sum, length) => sum + length, 0))
      let offset = 0
      for (const part of parts) {
        bytes.set(part, offset)
        offset += part.length
      }
      expect(encodeBase64(bytes)).toBe(Buffer.concat(parts).toString('base64'))
    },
  )
})

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../../convex/test/fixtures/segmented-video/${name}`, import.meta.url)),
  )
const word = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}
const box = (type: string, ...parts: Uint8Array[]) => {
  const data = Buffer.concat(parts)
  return Buffer.concat([word(data.length + 8), Buffer.from(type), data])
}
function init(audio = true, codec = 'mp4a') {
  const track = (id: number, type: string) =>
    box(
      'trak',
      box('tkhd', word(0), word(0), word(0), word(id)),
      box(
        'mdia',
        box('mdhd', word(0), word(0), word(0), word(48000)),
        box('hdlr', word(0), word(0), Buffer.from(type)),
        box(
          'minf',
          box('stbl', box('stsd', word(0), word(1), box(type === 'soun' ? codec : 'avc1'))),
        ),
      ),
    )
  return new Uint8Array(
    Buffer.concat([
      box('ftyp'),
      box('moov', box('mvex'), track(1, 'vide'), ...(audio ? [track(2, 'soun')] : [])),
    ]),
  )
}
function segment(ticks: number, audio = true) {
  const track = (id: number) =>
    box(
      'traf',
      box('tfhd', word(0x020000), word(id)),
      box('tfdt', word(0), word(0)),
      box('trun', word(0x701), word(1), word(200), word(ticks), word(4), word(0x02000000)),
    )
  return new Uint8Array(
    Buffer.concat([
      box('moof', track(1), ...(audio ? [track(2)] : [])),
      box('mdat', Buffer.from('test')),
    ]),
  )
}
async function transcribe(parts: Uint8Array[], startIndex = 0, aiError?: Error) {
  const run = vi.fn<Env['AI']['run']>()
  if (aiError) run.mockRejectedValue(aiError)
  else run.mockResolvedValue({ text: '', segments: [] })
  const get = vi.fn(async (key: string) => {
    const index = key.endsWith('init.mp4') ? 0 : Number(/segment-(\d+)/.exec(key)?.[1]) + 1
    const bytes = parts[index]
    return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null
  })
  const body = JSON.stringify({ recordingId: 'recording1', startIndex, endIndex: parts.length - 1 })
  const response = await transcribeRequest(
    new Request('https://media.example/internal/transcribe', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${'test'.repeat(8)}`,
        'Content-Length': String(body.length),
      },
      body,
    }),
    { MEDIA_WORKER_SECRET: 'test'.repeat(8), VIDEO: { get }, AI: { run } },
  )
  return { response, run, get }
}
describe('transcription media diagnosis', () => {
  it.each([
    { reason: 'missing_audio', parts: [init(false), segment(48000, false)] },
    { reason: 'unsupported_codec', parts: [init(true, 'enca'), segment(48000)] },
    { reason: 'zero_duration', parts: [init(), segment(0)] },
    { reason: 'zero_duration', parts: [init(), segment(48000, false)] },
  ])('classifies $reason without invoking AI', async ({ reason, parts }) => {
    const { response, run } = await transcribe(parts)
    expect(response.status).toBe(422)
    expect(await readTranscriptionFailureResponse(response)).toMatchObject({
      reason,
      name: 'TranscriptionError',
      probe: { status: reason },
    })
    expect(run).not.toHaveBeenCalled()
  })
  it('transcribes real H264/AAC fMP4 and returns a compact successful probe', async () => {
    const { response, run } = await transcribe([fixture('init.mp4'), fixture('segment-000000.m4s')])
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      text: '',
      probe: { status: 'ok', audioCodec: 'mp4a' },
    })
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('repairs an Android closing fragment using the predecessor outside the window', async () => {
    const raw = segment(0)
    const { response, run, get } = await transcribe([init(), segment(1024), raw], 1)
    expect(response.status).toBe(200)
    expect(get).toHaveBeenCalledWith('recording1/segment-000000.m4s')
    expect(run).toHaveBeenCalledWith(
      '@cf/openai/whisper-large-v3-turbo',
      expect.objectContaining({ audio: encodeBase64(Buffer.concat([init(), segment(1024)])) }),
    )
    expect(raw).toEqual(segment(0))
  })
  it('keeps an unrepairable zero-duration closing fragment terminal', async () => {
    const { response, run } = await transcribe([init(), segment(0), segment(0)], 1)
    expect(await readTranscriptionFailureResponse(response)).toMatchObject({
      reason: 'zero_duration',
      probe: { status: 'zero_duration', duration: 0 },
    })
    expect(run).not.toHaveBeenCalled()
  })
  it('keeps provider outages retryable even after a successful media probe', async () => {
    const { response } = await transcribe(
      [init(), segment(48000)],
      0,
      new Error('Provider temporarily unavailable'),
    )
    expect(await readTranscriptionFailureResponse(response)).toMatchObject({
      reason: 'transcription_error',
      message: 'Provider temporarily unavailable',
      probe: { status: 'ok', audioCodec: 'mp4a', duration: 1 },
    })
  })
  it('requires an explicit provider rejection before declaring an unknown codec unsupported', async () => {
    const parts = [init(true, 'zzzz'), segment(48000)]
    expect((await transcribe(parts)).response.status).toBe(200)
    const { response } = await transcribe(parts, 0, new Error('Unsupported audio codec: zzzz'))
    expect(await readTranscriptionFailureResponse(response)).toMatchObject({
      reason: 'unsupported_codec',
      probe: { status: 'unsupported_codec', audioCodec: 'zzzz' },
    })
    const transient = await transcribe(parts, 0, new Error('Temporary decode service failure'))
    expect(await readTranscriptionFailureResponse(transient.response)).toMatchObject({
      reason: 'transcription_error',
    })
  })
  it('reports malformed media without guessing it is a missing audio track', async () => {
    const { response, run } = await transcribe([new Uint8Array(8), segment(48000)])
    expect(await readTranscriptionFailureResponse(response)).toMatchObject({
      reason: 'transcription_error',
      probe: { status: 'invalid_mp4' },
    })
    expect(run).not.toHaveBeenCalled()
  })
  it('bounds and redacts error diagnostics', () => {
    const failure = normalizeTranscriptionFailure(
      new TypeError(
        `fetch https://private.example?token=secret Bearer credential ${'x'.repeat(100)} ${'detail '.repeat(100)}`,
      ),
    )
    expect(failure.name).toBe('TypeError')
    expect(failure.message.length).toBeLessThanOrEqual(240)
    expect(failure.message).not.toMatch(/private|secret|credential|x{64}/)
    expect(failure).not.toHaveProperty('stack')
  })
  it('normalizes local errors with the same evidence checks as remote failures', () => {
    expect(
      normalizeTranscriptionFailure(new TranscriptionError(' missing_audio ', 'Unconfirmed')),
    ).toMatchObject({ reason: 'transcription_error', probe: { status: 'not_probed' } })
  })
  it('bounds successful probes and discards duration values that overflow normalization', () => {
    expect(
      readMediaProbe({
        status: 'ok',
        audioCodec: 'mp4a',
        duration: 1.23456,
        transcript: 'private',
      }),
    ).toEqual({ status: 'ok', audioCodec: 'mp4a', duration: 1.235 })
    for (const duration of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])
      expect(readMediaProbe({ status: 'ok', duration })).toEqual({ status: 'ok' })
    expect(readMediaProbe({ status: 'unknown' })).toBeUndefined()
  })
  it('ignores oversized, malformed and unstructured HTTP error responses', async () => {
    for (const response of [
      Response.json({ failure: 'x'.repeat(3000) }),
      new Response('{', { headers: { 'Content-Type': 'application/json' } }),
      new Response('private upstream body'),
    ]) {
      expect(await readTranscriptionFailureResponse(response)).toBeUndefined()
    }
  })
  it('treats an errored response body as unavailable diagnostics', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('Upstream disconnected'))
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
    await expect(readTranscriptionFailureResponse(response)).resolves.toBeUndefined()
  })
  it('cancels an oversized stream even if cancellation rejects', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('Cancellation failed')
    })
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2049))
        },
        cancel,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
    await expect(readTranscriptionFailureResponse(response)).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
