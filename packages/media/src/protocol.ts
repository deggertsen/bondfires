/** Versioned wire contract shared by Convex and the private media Worker. */
export const MEDIA_AUDIENCE = 'bondfires-internal-video-v1'
export const INTERNAL_CONVEX_URL = 'https://lovely-malamute-525.convex.cloud'
export const MAX_SEGMENT_BYTES = 8 * 1024 * 1024
export const MAX_SEGMENTS = 1800
export const MAX_RECORDING_SECONDS = 60 * 60
export const SEGMENT_NAME = /^segment-(\d{6})\.m4s$/
export type MediaCapability = {
  audience: typeof MEDIA_AUDIENCE
  recordingId: string
  userId: string
  operation: 'upload' | 'read'
  expiresAt: number
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid token')
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}
async function key(secret: string) {
  if (secret.length < 32) throw new Error('Media signing is not configured')
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}
export async function signCapability(claims: MediaCapability, secret: string): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    new TextEncoder().encode(payload),
  )
  return `${payload}.${base64Url(new Uint8Array(signature))}`
}
export async function verifyCapability(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<MediaCapability> {
  if (token.length > 2048) throw new Error('Invalid token')
  const parts = token.split('.')
  if (parts.length !== 2) throw new Error('Invalid token')
  const valid = await crypto.subtle.verify(
    'HMAC',
    await key(secret),
    fromBase64Url(parts[1]),
    new TextEncoder().encode(parts[0]),
  )
  if (!valid) throw new Error('Invalid token')
  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as MediaCapability
  if (
    claims.audience !== MEDIA_AUDIENCE ||
    !/^[a-z0-9]+$/.test(claims.recordingId) ||
    typeof claims.userId !== 'string' ||
    !['upload', 'read'].includes(claims.operation) ||
    !Number.isFinite(claims.expiresAt) ||
    claims.expiresAt <= now ||
    claims.expiresAt > now + 13 * 60 * 60_000
  ) {
    throw new Error('Invalid token')
  }
  return claims
}
export async function equalSecret(actual: string, expected: string): Promise<boolean> {
  if (expected.length < 32) return false
  const k = await key(expected)
  const message = new TextEncoder().encode('worker-to-convex')
  const provided = await crypto.subtle.sign(
    'HMAC',
    await key(actual.length >= 32 ? actual : '0'.repeat(32)),
    message,
  )
  return crypto.subtle.verify('HMAC', k, provided, message)
}
export function segmentName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SEGMENTS)
    throw new Error('Invalid segment index')
  return `segment-${String(index).padStart(6, '0')}.m4s`
}
export type MediaSegment = { index: number; duration: number }
export function buildPlaylist(
  segments: readonly MediaSegment[],
  complete: boolean,
  token: string,
): string {
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) throw new Error('Media is not ready')
  let total = 0
  for (const [index, segment] of segments.entries()) {
    if (
      segment.index !== index ||
      !Number.isFinite(segment.duration) ||
      segment.duration <= 0 ||
      segment.duration > 15
    )
      throw new Error('Invalid media timeline')
    total += segment.duration
  }
  if (total > MAX_RECORDING_SECONDS + 15) throw new Error('Recording is too long')
  const query = `?token=${encodeURIComponent(token)}`
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:EVENT',
    '#EXT-X-TARGETDURATION:15',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES',
    `#EXT-X-MAP:URI="init.mp4${query}"`,
    ...segments.flatMap((s) => [
      `#EXTINF:${s.duration.toFixed(6)},`,
      `${segmentName(s.index)}${query}`,
    ]),
    ...(complete ? ['#EXT-X-ENDLIST'] : []),
    '',
  ].join('\n')
}
