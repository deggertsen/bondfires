/** Bounded ISO-BMFF inspection. We accept complete fMP4 fragments, never arbitrary upload metadata. */
type Box = { type: string; start: number; end: number; data: number }
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const result: Box[] = []
  while (start < end) {
    if (end - start < 8 || result.length > 4096) throw new Error('Invalid MP4 boxes')
    let size = view.getUint32(start)
    const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8))
    let header = 8
    if (size === 1) {
      if (end - start < 16) throw new Error('Invalid MP4 size')
      size = Number(view.getBigUint64(start + 8))
      header = 16
    }
    if (!Number.isSafeInteger(size) || size < header || start + size > end)
      throw new Error('Incomplete MP4 box')
    result.push({ type, start, end: start + size, data: start + header })
    start += size
  }
  return result
}
function required(items: Box[], type: string): Box {
  const item = items.find((b) => b.type === type)
  if (!item) throw new Error(`Missing MP4 ${type}`)
  return item
}
function u32(view: DataView, box: Box, offset: number): number {
  if (offset < box.data || offset + 4 > box.end) throw new Error('Incomplete MP4 field')
  return view.getUint32(offset)
}
export type Track = { id: number; timescale: number; type: string; defaultDuration: number }
export function inspectInit(bytes: Uint8Array): Track[] {
  if (bytes.length > 256 * 1024) throw new Error('Initialization too large')
  const root = boxes(bytes)
  required(root, 'ftyp')
  const moov = required(root, 'moov')
  const children = boxes(bytes, moov.data, moov.end)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const mvex = required(children, 'mvex')
  const defaults = new Map(
    boxes(bytes, mvex.data, mvex.end)
      .filter((b) => b.type === 'trex')
      .map((b) => [u32(view, b, b.data + 4), u32(view, b, b.data + 12)]),
  )
  const tracks = children
    .filter((b) => b.type === 'trak')
    .map((trak) => {
      const children = boxes(bytes, trak.data, trak.end)
      const tkhd = required(children, 'tkhd')
      const id = u32(view, tkhd, tkhd.data + (bytes[tkhd.data] === 1 ? 20 : 12))
      const mdia = required(children, 'mdia')
      const media = boxes(bytes, mdia.data, mdia.end)
      const mdhd = required(media, 'mdhd')
      const timescale = u32(view, mdhd, mdhd.data + (bytes[mdhd.data] === 1 ? 20 : 12))
      const hdlr = required(media, 'hdlr')
      u32(view, hdlr, hdlr.data + 8)
      const type = String.fromCharCode(...bytes.subarray(hdlr.data + 8, hdlr.data + 12))
      if (!timescale || !id || !['vide', 'soun'].includes(type))
        throw new Error('Unsupported track')
      return { id, timescale, type, defaultDuration: defaults.get(id) ?? 0 }
    })
  if (new Set(tracks.map((t) => t.id)).size !== tracks.length) throw new Error('Duplicate track')
  if (
    tracks.length !== 2 ||
    !tracks.some((t) => t.type === 'vide') ||
    !tracks.some((t) => t.type === 'soun')
  )
    throw new Error('Audio and video tracks required')
  return tracks
}
export function inspectSegment(bytes: Uint8Array, tracks: readonly Track[]): number {
  const root = boxes(bytes)
  const moof = required(root, 'moof')
  required(root, 'mdat')
  if (root.filter((b) => b.type === 'moof').length !== 1) throw new Error('One fragment required')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let duration = 0
  for (const traf of boxes(bytes, moof.data, moof.end).filter((b) => b.type === 'traf')) {
    const children = boxes(bytes, traf.data, traf.end)
    const tfhd = required(children, 'tfhd')
    const flags = u32(view, tfhd, tfhd.data) & 0xffffff
    const track = tracks.find((t) => t.id === u32(view, tfhd, tfhd.data + 4))
    if (!track) throw new Error('Unknown track')
    const tfdt = required(children, 'tfdt')
    u32(view, tfdt, tfdt.data + 4)
    let offset = tfhd.data + 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0)
    const defaultDuration = flags & 8 ? u32(view, tfhd, offset) : track.defaultDuration
    let ticks = 0
    for (const trun of children.filter((b) => b.type === 'trun')) {
      const runFlags = u32(view, trun, trun.data) & 0xffffff
      const count = u32(view, trun, trun.data + 4)
      if (count > 10000) throw new Error('Too many samples')
      offset = trun.data + 8 + (runFlags & 1 ? 4 : 0) + (runFlags & 4 ? 4 : 0)
      for (let i = 0; i < count; i++) {
        if (offset > trun.end) throw new Error('Incomplete sample table')
        ticks += runFlags & 0x100 ? u32(view, trun, offset) : defaultDuration
        offset +=
          (runFlags & 0x100 ? 4 : 0) +
          (runFlags & 0x200 ? 4 : 0) +
          (runFlags & 0x400 ? 4 : 0) +
          (runFlags & 0x800 ? 4 : 0)
      }
      if (offset !== trun.end) throw new Error('Invalid sample table')
    }
    duration = Math.max(duration, ticks / track.timescale)
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 15)
    throw new Error('Invalid segment duration')
  return duration
}

/**
 * Early Android captures labelled AAC as non-sync video samples. ExoPlayer
 * drops those samples while waiting for the first sync sample. Correct only
 * the audio sample flags on delivery; stored uploads and checksums stay intact.
 * The internal capture contract is H.264 + independently decodable AAC-LC.
 */
export function normalizeAacSampleFlags(bytes: Uint8Array, tracks: readonly Track[]): Uint8Array {
  inspectSegment(bytes, tracks)
  let result = bytes
  const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const normalize = (box: Box, offset: number) => {
    const flags = u32(source, box, offset)
    const corrected = ((flags & ~0x03010000) | 0x02000000) >>> 0
    if (corrected === flags) return
    if (result === bytes) result = bytes.slice()
    new DataView(result.buffer, result.byteOffset, result.byteLength).setUint32(offset, corrected)
  }
  const moof = required(boxes(bytes), 'moof')
  for (const traf of boxes(bytes, moof.data, moof.end).filter((box) => box.type === 'traf')) {
    const children = boxes(bytes, traf.data, traf.end)
    const tfhd = required(children, 'tfhd')
    const trackId = u32(source, tfhd, tfhd.data + 4)
    if (tracks.find((track) => track.id === trackId)?.type !== 'soun') continue
    const flags = u32(source, tfhd, tfhd.data) & 0xffffff
    if (flags & 0x20) {
      const offset =
        tfhd.data +
        8 +
        (flags & 1 ? 8 : 0) +
        (flags & 2 ? 4 : 0) +
        (flags & 8 ? 4 : 0) +
        (flags & 0x10 ? 4 : 0)
      normalize(tfhd, offset)
    }
    for (const trun of children.filter((box) => box.type === 'trun')) {
      const flags = u32(source, trun, trun.data) & 0xffffff
      const count = u32(source, trun, trun.data + 4)
      let offset = trun.data + 8 + (flags & 1 ? 4 : 0)
      if (flags & 4) {
        normalize(trun, offset)
        offset += 4
      }
      for (let i = 0; i < count; i++) {
        offset += (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0)
        if (flags & 0x400) {
          normalize(trun, offset)
          offset += 4
        }
        offset += flags & 0x800 ? 4 : 0
      }
    }
  }
  return result
}
