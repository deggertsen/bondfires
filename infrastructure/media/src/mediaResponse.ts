/** Byte ranges apply to the delivered representation, including corrected MP4 headers. */
export function mediaResponse(request: Request, bytes: Uint8Array, etag: string): Response {
  const headers = new Headers({
    'Content-Type': 'video/mp4',
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Content-Length': String(bytes.length),
  })
  const range = request.headers.get('range')
  const ifRange = request.headers.get('if-range')
  const match = (!ifRange || ifRange === etag) && range?.match(/^bytes=(\d*)-(\d*)$/)
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]))
    const end =
      match[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= bytes.length
    ) {
      headers.set('Content-Range', `bytes */${bytes.length}`)
      headers.set('Content-Length', '0')
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${bytes.length}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(request.method === 'HEAD' ? null : bytes.slice(start, end + 1), {
      status: 206,
      headers,
    })
  }
  return new Response(request.method === 'HEAD' ? null : bytes.slice(), { headers })
}
