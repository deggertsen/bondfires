import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { encodeBase64 } from './transcription'

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
