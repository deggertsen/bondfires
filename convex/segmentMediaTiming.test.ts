import { describe, expect, it } from 'vitest'
import { inspectSegment, repairSingleSampleDuration, type Track } from '../packages/media/src/mp4'

const word = (value: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value)
  return b
}
const box = (type: string, ...parts: Uint8Array[]) => {
  const data = Buffer.concat(parts)
  return Buffer.concat([word(data.length + 8), Buffer.from(type), data])
}
const tracks: Track[] = [
  { id: 1, timescale: 90000, type: 'vide', defaultDuration: 0 },
  { id: 2, timescale: 48000, type: 'soun', defaultDuration: 0 },
]
const track = (id: number, durations: number[]) =>
  box(
    'traf',
    box('tfhd', word(0x020000), word(id)),
    box('tfdt', word(0x01000000), word(0), word(100000)),
    box(
      'trun',
      word(0x701),
      word(durations.length),
      word(200),
      ...durations.flatMap((ticks) => [word(ticks), word(4), word(0x02000000)]),
    ),
  )
const fragment = (video: number[], audio: number[]) =>
  new Uint8Array(
    Buffer.concat([
      box(
        'moof',
        box('mfhd', word(0), word(4)),
        ...(video.length ? [track(1, video)] : []),
        ...(audio.length ? [track(2, audio)] : []),
      ),
      box('mdat', Buffer.from('encoded media remains unchanged')),
    ]),
  )
const previous = fragment([3750, 3750, 3750], [1115, 1114, 1115])

describe('Media3 single-sample closing fragment', () => {
  it('recovers zero timing with the preceding cadence without changing payload, timestamps or offsets', () => {
    const original = fragment([0], [0])
    const saved = original.slice()
    const result = repairSingleSampleDuration(original, tracks, previous)
    expect(result).toEqual(fragment([3750], [1115]))
    expect(original).toEqual(saved)
    expect(inspectSegment(result, tracks)).toBeCloseTo(1 / 24)
    expect(repairSingleSampleDuration(result, tracks, previous)).toBe(result)
  })
  it('supports a final video-only frame or audio-only sample', () => {
    expect(repairSingleSampleDuration(fragment([0], []), tracks, previous)).toEqual(
      fragment([3750], []),
    )
    expect(repairSingleSampleDuration(fragment([], [0]), tracks, previous)).toEqual(
      fragment([], [1115]),
    )
  })
  it('leaves valid fragments byte-identical and rejects unsupported or malformed timing', () => {
    expect(repairSingleSampleDuration(previous, tracks, previous)).toBe(previous)
    expect(() => repairSingleSampleDuration(fragment([0, 0], [0]), tracks, previous)).toThrow()
    expect(() =>
      repairSingleSampleDuration(fragment([0], [0]), tracks, fragment([3750], [])),
    ).toThrow()
    expect(() =>
      repairSingleSampleDuration(fragment([0], []), tracks, fragment([180000], [])),
    ).toThrow()
    expect(() =>
      repairSingleSampleDuration(fragment([0], [0]).slice(0, -1), tracks, previous),
    ).toThrow()
    expect(() =>
      repairSingleSampleDuration(fragment([0], [0]), tracks, fragment([0], [0])),
    ).toThrow()
    expect(() =>
      repairSingleSampleDuration(fragment([90_000 * 16], []), tracks, previous),
    ).toThrow()
  })
})
