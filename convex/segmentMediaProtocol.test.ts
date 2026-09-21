import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspectInit, inspectSegment } from '../packages/media/src/mp4'
import {
  buildPlaylist,
  MEDIA_AUDIENCE,
  signCapability,
  verifyCapability,
} from '../packages/media/src/protocol'

const secret = 'test-secret-with-at-least-thirty-two-characters'
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./test/fixtures/segmented-video/${name}`, import.meta.url)))
describe('segmented media wire protocol', () => {
  it('binds capabilities to signed claims and rejects changes and expired tokens', async () => {
    const claims = {
      audience: MEDIA_AUDIENCE as typeof MEDIA_AUDIENCE,
      recordingId: 'recording1',
      userId: 'user1',
      operation: 'read' as const,
      expiresAt: Date.now() + 60_000,
    }
    const token = await signCapability(claims, secret)
    expect(await verifyCapability(token, secret)).toEqual(claims)
    await expect(verifyCapability(token, `${secret}-wrong`)).rejects.toThrow()
    await expect(verifyCapability(token, secret, claims.expiresAt)).rejects.toThrow()
    await expect(verifyCapability(`e30.${token.split('.')[1]}`, secret)).rejects.toThrow()
    await expect(verifyCapability('x'.repeat(2049), secret)).rejects.toThrow()
  })
  it('keeps the HLS target duration stable as media arrives and ends only complete recordings', () => {
    const first = buildPlaylist([{ index: 0, duration: 3.9 }], false, 'a.b')
    const final = buildPlaylist(
      [
        { index: 0, duration: 3.9 },
        { index: 1, duration: 4.1 },
      ],
      true,
      'a.b',
    )
    expect(first).toContain('#EXT-X-TARGETDURATION:15')
    expect(final).toContain('#EXT-X-TARGETDURATION:15')
    expect(first).not.toContain('#EXT-X-ENDLIST')
    expect(final).toContain('#EXT-X-ENDLIST')
    expect(first).toContain('init.mp4?token=a.b')
    expect(() => buildPlaylist([{ index: 1, duration: 4 }], false, 'x')).toThrow()
    expect(() => buildPlaylist([{ index: 0, duration: Number.NaN }], false, 'x')).toThrow()
  })
  it('reads real H264/AAC fragmented MP4 and rejects incomplete bytes', () => {
    const tracks = inspectInit(fixture('init.mp4'))
    expect(tracks.map((t) => t.type).sort()).toEqual(['soun', 'vide'])
    const fragment = fixture('segment-000000.m4s')
    expect(inspectSegment(fragment, tracks)).toBeGreaterThan(0.9)
    expect(inspectSegment(fragment, tracks)).toBeLessThan(1.2)
    expect(() => inspectSegment(fragment.subarray(0, fragment.length - 1), tracks)).toThrow()
    expect(() => inspectInit(new Uint8Array(16))).toThrow()
    expect(() => inspectSegment(fragment, [])).toThrow()
  })
})
