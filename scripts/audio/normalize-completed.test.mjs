import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCompletedPlaylist, readCompletedPlaylist } from './completed-playlist.mjs'
import { normalizeCompleted } from './normalize-completed.mjs'

const manifest =
  '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nsegment-000000.m4s\n#EXT-X-ENDLIST\n'
const directories = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'normalization-guard-'))
  directories.push(directory)
  const input = join(directory, 'index.m3u8')
  const output = join(directory, 'output.mp4')
  writeFileSync(input, manifest)
  for (const name of ['init.mp4', 'segment-000000.m4s'])
    writeFileSync(join(directory, name), 'placeholder')
  return { directory, input, output }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('offline completed-recording guard', () => {
  it('rejects growing playlists before invoking a decoder or touching output', () => {
    const { input, output } = fixture()
    writeFileSync(input, manifest.replace('#EXT-X-ENDLIST\n', ''))
    writeFileSync(output, 'immutable')
    expect(() => normalizeCompleted(input, output)).toThrow('still growing')
    expect(readFileSync(output, 'utf8')).toBe('immutable')
  })

  it.each(['https://example.com/audio.m3u8', '../segment-000000.m4s', 'segment-000001.m4s'])(
    'rejects nonlocal or out-of-order segment %s',
    (segment) => {
      expect(() => parseCompletedPlaylist(manifest.replace('segment-000000.m4s', segment))).toThrow(
        'local completed',
      )
    },
  )

  it.each([
    '#EXT-X-BYTERANGE:1@0',
    '#EXT-X-GAP',
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-KEY:METHOD=AES-128,URI="key"',
    '#EXT-X-MEDIA:TYPE=AUDIO,URI="other.m3u8"',
    '#EXT-X-ENDLIST',
    '#EXT-X-MAP:URI="init.mp4"',
  ])('rejects ambiguous playlist directives: %s', (tag) => {
    expect(() => parseCompletedPlaylist(manifest.replace('#EXTINF:', `${tag}\n#EXTINF:`))).toThrow(
      'local completed',
    )
  })

  it('requires a header, initialization before media, and adjacent duration/URI pairs', () => {
    for (const malformed of [
      manifest.replace('#EXTM3U\n', ''),
      manifest.replace('#EXT-X-MAP:URI="init.mp4"\n', ''),
      manifest.replace('#EXTINF:4,\nsegment-000000.m4s', 'segment-000000.m4s\n#EXTINF:4,'),
      manifest.replace('#EXT-X-ENDLIST\n', '#EXT-X-ENDLIST\n#EXTINF:4,\nsegment-000001.m4s\n'),
    ])
      expect(() => parseCompletedPlaylist(malformed)).toThrow('local completed')
  })

  it('accepts completed EVENT and VOD downloads and CRLF line endings', () => {
    for (const type of ['EVENT', 'VOD']) {
      const headers = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:15\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:${type}\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES`
      expect(
        parseCompletedPlaylist(manifest.replace('#EXTM3U', headers).replaceAll('\n', '\r\n')),
      ).toEqual({ segments: ['segment-000000.m4s'], duration: 4 })
    }
  })

  it.each(['0', '-1', 'NaN', 'Infinity', '16', '0x4'])(
    'rejects invalid duration %s',
    (duration) => {
      expect(() =>
        parseCompletedPlaylist(manifest.replace('#EXTINF:4,', `#EXTINF:${duration},`)),
      ).toThrow('duration')
    },
  )

  it('bounds total duration and segment count', () => {
    for (const [count, seconds] of [
      [242, 15],
      [1801, 1],
    ]) {
      const media = Array.from(
        { length: count },
        (_, index) => `#EXTINF:${seconds},\nsegment-${String(index).padStart(6, '0')}.m4s`,
      ).join('\n')
      expect(() =>
        parseCompletedPlaylist(manifest.replace('#EXTINF:4,\nsegment-000000.m4s', media)),
      ).toThrow()
    }
  })

  it.each(['empty', 'directory', 'symlink', 'oversized'])('rejects %s fragments', (kind) => {
    const { input, directory } = fixture()
    const fragment = join(directory, 'segment-000000.m4s')
    rmSync(fragment)
    if (kind === 'empty') writeFileSync(fragment, '')
    if (kind === 'directory') mkdirSync(fragment)
    if (kind === 'symlink') symlinkSync(join(directory, 'init.mp4'), fragment)
    if (kind === 'oversized') {
      writeFileSync(fragment, '')
      truncateSync(fragment, 8 * 1024 * 1024 + 1)
    }
    expect(() => readCompletedPlaylist(input)).toThrow('regular source file')
  })

  it('rejects oversized manifests before reading them', () => {
    const { input } = fixture()
    truncateSync(input, 256 * 1024 + 1)
    expect(() => readCompletedPlaylist(input)).toThrow('regular source file')
  })

  it('refuses existing outputs and dangling symlinks before decoding', () => {
    const { input, output, directory } = fixture()
    writeFileSync(output, 'immutable')
    expect(() => normalizeCompleted(input, output)).toThrow('Output already exists')
    expect(readFileSync(output, 'utf8')).toBe('immutable')
    rmSync(output)
    symlinkSync(join(directory, 'missing.mp4'), output)
    expect(() => normalizeCompleted(input, output)).toThrow('Output already exists')
    expect(lstatSync(output).isSymbolicLink()).toBe(true)
  })
})
