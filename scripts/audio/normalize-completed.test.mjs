import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeCompleted } from './normalize-completed.mjs'

describe('offline completed-recording guard', () => {
  it('rejects growing playlists before invoking a decoder or touching output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'normalization-guard-'))
    const input = join(directory, 'index.m3u8')
    const output = join(directory, 'existing.mp4')
    writeFileSync(input, '#EXTM3U\n#EXTINF:4,\nsegment-000000.m4s\n')
    writeFileSync(output, 'immutable')
    expect(() => normalizeCompleted(input, output)).toThrow('still growing')
    expect(readFileSync(output, 'utf8')).toBe('immutable')
  })
  it.each(['https://example.com/audio.m3u8', '../segment-000000.m4s', 'segment-000001.m4s'])(
    'rejects nonlocal or out-of-order segment %s',
    (segment) => {
      const directory = mkdtempSync(join(tmpdir(), 'normalization-guard-'))
      const input = join(directory, 'index.m3u8')
      writeFileSync(
        input,
        `#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\n${segment}\n#EXT-X-ENDLIST\n`,
      )
      expect(() => normalizeCompleted(input, join(directory, 'output.mp4'))).toThrow(
        'local completed',
      )
    },
  )
})
