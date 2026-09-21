import { describe, expect, it } from 'vitest'
import { mediaResponse } from '../infrastructure/media/src/mediaResponse'
import { normalizeAacSampleFlags, type Track } from '../packages/media/src/mp4'

const word = (n: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(n)
  return bytes
}
const box = (type: string, ...parts: Uint8Array[]) => {
  const data = Buffer.concat(parts)
  return Buffer.concat([word(data.length + 8), Buffer.from(type), data])
}
const tracks: Track[] = [
  { id: 1, timescale: 90000, type: 'vide', defaultDuration: 0 },
  { id: 2, timescale: 44100, type: 'soun', defaultDuration: 0 },
]
const video = box(
  'traf',
  box('tfhd', word(0x020000), word(1)),
  box('tfdt', word(0), word(0)),
  box('trun', word(0x700), word(1), word(90000), word(4), word(0x01010000)),
)
const fragment = (audio: Uint8Array) => box('moof', video, audio)
const sampleAudio = (flags: number, id = 2) =>
  box(
    'traf',
    box('tfhd', word(0x020000), word(id)),
    box('tfdt', word(0), word(0)),
    box(
      'trun',
      word(0x700),
      word(2),
      word(22050),
      word(3),
      word(flags),
      word(22050),
      word(3),
      word(flags),
    ),
  )
const withMedia = (audio: Uint8Array) =>
  new Uint8Array(Buffer.concat([fragment(audio), box('mdat', Buffer.from('unchanged payload'))]))

describe('AAC playback compatibility', () => {
  it('corrects audio sync flags without touching video, timing, payload, length or the stored input', () => {
    const old = withMedia(sampleAudio(0x01010000))
    const original = old.slice()
    const expected = withMedia(sampleAudio(0x02000000))
    const corrected = normalizeAacSampleFlags(old, tracks)
    expect(corrected).toEqual(expected)
    expect(old).toEqual(original)
    expect(corrected.length).toBe(old.length)
    expect(normalizeAacSampleFlags(corrected, tracks)).toBe(corrected)
    // Track order/IDs come from the initialization, never a guessed audio ID.
    expect(
      normalizeAacSampleFlags(withMedia(sampleAudio(0x01010000, 3)), [
        tracks[0],
        { ...tracks[1], id: 3 },
      ]),
    ).toEqual(withMedia(sampleAudio(0x02000000, 3)))
  })
  it('handles audio flags inherited from tfhd and first-sample overrides', () => {
    const audio = (flags: number) =>
      box(
        'traf',
        box('tfhd', word(0x020028), word(2), word(44100), word(flags)),
        box('tfdt', word(0), word(0)),
        box('trun', word(0x204), word(1), word(flags), word(4)),
      )
    expect(normalizeAacSampleFlags(withMedia(audio(0x01010000)), tracks)).toEqual(
      withMedia(audio(0x02000000)),
    )
  })
  it('rejects malformed fragments before modifying data', () => {
    const bytes = withMedia(sampleAudio(0x01010000))
    expect(() => normalizeAacSampleFlags(bytes.slice(0, -1), tracks)).toThrow()
    expect(() => normalizeAacSampleFlags(bytes, [])).toThrow()
  })
})
describe('corrected media range delivery', () => {
  const bytes = normalizeAacSampleFlags(withMedia(sampleAudio(0x01010000)), tracks)
  const etag = '"aac-sync-v1-test"'
  const request = (range?: string, method = 'GET', ifRange?: string) =>
    new Request('https://media.test/segment.m4s', {
      method,
      headers: { ...(range ? { Range: range } : {}), ...(ifRange ? { 'If-Range': ifRange } : {}) },
    })
  it.each(['bytes=0-15', 'bytes=10-', 'bytes=-10'])(
    'serves exact corrected bytes for %s',
    async (range) => {
      const response = mediaResponse(request(range), bytes, etag)
      expect(response.status).toBe(206)
      const bounds = response.headers.get('Content-Range')?.match(/bytes (\d+)-(\d+)/)
      if (!bounds) throw new Error('Missing range bounds')
      const [start, end] = bounds.slice(1).map(Number)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(start, end + 1))
      expect(Number(response.headers.get('Content-Length'))).toBe(end - start + 1)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    },
  )
  it('handles HEAD, unsatisfiable ranges and stale If-Range without corrupting headers', async () => {
    const head = mediaResponse(request('bytes=0-15', 'HEAD'), bytes, etag)
    expect(head.status).toBe(206)
    expect(head.headers.get('Content-Length')).toBe('16')
    expect(await head.text()).toBe('')
    for (const range of ['bytes=99999-', 'bytes=-0', 'bytes=10-1'])
      expect(mediaResponse(request(range), bytes, etag).status).toBe(416)
    const stale = mediaResponse(request('bytes=0-15', 'GET', '"old"'), bytes, etag)
    expect(stale.status).toBe(200)
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(bytes)
  })
})
