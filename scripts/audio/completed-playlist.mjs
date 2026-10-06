import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The offline download contract, not a general-purpose HLS parser. */
export function parseCompletedPlaylist(manifest) {
  const lines = manifest.split(/\r?\n/).filter((line) => line !== '')
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('Recording is still growing')
  const invalid = () => new Error('Expected local completed fMP4 playlist')
  if (lines.shift() !== '#EXTM3U' || lines.pop() !== '#EXT-X-ENDLIST') throw invalid()
  const segments = []
  const headers = new Set()
  let hasMap = false
  let duration = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.startsWith('#EXTINF:')) {
      const match = /^#EXTINF:(\d+(?:\.\d+)?),$/.exec(line)
      const seconds = match ? Number(match[1]) : NaN
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 15)
        throw new Error('Invalid recording duration')
      const name = `segment-${String(segments.length).padStart(6, '0')}.m4s`
      if (!hasMap || lines[++index] !== name) throw invalid()
      duration += seconds
      segments.push(name)
    } else {
      // Reject directives that can change which bytes FFmpeg decodes (ranges,
      // gaps, keys, alternate media, discontinuities), and duplicate headers.
      if (
        segments.length ||
        !/^(?:#EXT-X-VERSION:[1-7]|#EXT-X-TARGETDURATION:(?:[1-9]|1[0-5])|#EXT-X-MEDIA-SEQUENCE:0|#EXT-X-PLAYLIST-TYPE:(?:EVENT|VOD)|#EXT-X-START:TIME-OFFSET=0,PRECISE=YES|#EXT-X-INDEPENDENT-SEGMENTS|#EXT-X-MAP:URI="init\.mp4")$/.test(
          line,
        )
      )
        throw invalid()
      const key = line.split(':')[0]
      if (headers.has(key)) throw invalid()
      headers.add(key)
      if (key === '#EXT-X-MAP') hasMap = true
    }
  }
  if (!segments.length || segments.length > 1800) throw invalid()
  if (duration > 3615) throw new Error('Invalid recording duration')
  return segments
}

function checkFile(path, maxBytes) {
  const info = lstatSync(path)
  if (!info.isFile() || info.size === 0 || info.size > maxBytes)
    throw new Error(`Expected nonempty, bounded regular source file: ${path}`)
}

export function readCompletedPlaylist(input) {
  checkFile(input, 256 * 1024)
  const segments = parseCompletedPlaylist(readFileSync(input, 'utf8'))
  for (const name of ['init.mp4', ...segments])
    checkFile(join(dirname(input), name), name === 'init.mp4' ? 256 * 1024 : 8 * 1024 * 1024)
}
