import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { auth } from './auth'
import { type BondfireFailureReason, handleFailedBondfire } from './bondfireFailureCleanup'
import {
  isCampParticipableStatus,
  isCampReadableStatus,
  requiresActiveMembershipForVisibility,
} from './campLifecycle'
import {
  assertCanCreateBondfire,
  assertVideoDurationWithinTierLimit,
  getEntitlementSubscriptionTier,
  getPrivateCampExpiresAt,
  getTierMaxVideoDurationMs,
  PAID_TIERS,
  PRO_MAX_VIDEO_DURATION_MS,
} from './entitlements'
import { throwUserError, withUserFacingActionErrors } from './errors'
import { classifyMuxIngest, type IngestEvidence, localIngestSource } from './lib/liveIngest'
import {
  assertCanRespondToPersonalBondfire,
  canViewPersonalBondfire,
} from './personalBondfireAccess'
import { countResponse, uncountResponse } from './responseCounts'
import { logServerEvent } from './serverTelemetry'

type PlaybackPolicy = 'public' | 'signed'
type LiveLatencyMode = 'standard' | 'reduced' | 'low'
type MuxSignedAudience = 'v' | 't' | 'g'
type MuxRecord =
  | { table: 'bondfires'; document: Doc<'bondfires'> }
  | { table: 'bondfireVideos'; document: Doc<'bondfireVideos'> }
type ExpiredPrivateCampVideoCleanupBatch = {
  bondfireIds: Array<Id<'bondfires'>>
  muxAssetIds: string[]
  expiredBondfires: number
  remainingMayExist: boolean
}
type StuckMuxRecord = {
  table: 'bondfires' | 'bondfireVideos'
  recordId: Id<'bondfires'> | Id<'bondfireVideos'>
  userId: Id<'users'>
  videoStatus: 'waiting_for_upload' | 'processing'
  stuckForMs: number
  muxUploadId?: string
  muxAssetId?: string
  muxLiveStreamId?: string
}
type ReconcileOutcome = 'recovered' | 'errored' | 'still_processing' | 'unresolved'
type DisableMuxLiveStreamOutcome = 'disabled' | 'missing' | 'error'
type ExpiredPrivateCampVideoCleanupResult = {
  expiredBondfires?: number
  muxAssetsToDelete?: number
  deletedBondfires?: number
  deletedResponses?: number
  deletedMuxAssets?: number
  missingMuxAssets?: number
  remainingMayExist: boolean
}
type MuxErrorDetail = {
  type?: string
  code?: string
  messages: string[]
}
type MuxErrorInfo = {
  message?: string
  details?: MuxErrorDetail[]
}

interface EndLiveStreamResult {
  ended: boolean
  completeSignaled: boolean
  recordingStarted: boolean
}

interface MuxDirectUploadResult {
  uploadId: string
  uploadUrl: string
  recordId: Id<'bondfires'> | Id<'bondfireVideos'>
  recordType: 'bondfire' | 'response'
  expiresIn: number
}

interface MuxLiveStreamResult {
  liveStreamId: string
  liveSessionId: Id<'liveSessions'>
  playbackId?: string
  playbackUrl?: string
  ingest: {
    rtmpsUrl: string
    streamKey: string
  }
  recordId: Id<'bondfires'> | Id<'bondfireVideos'>
  recordType: 'bondfire' | 'response'
}

const MUX_API_BASE_URL = 'https://api.mux.com/video/v1'
const GENERATED_SUBTITLES_SETTINGS = { language_code: 'en', name: 'English (generated)' }
const MUX_UPLOAD_TIMEOUT_MIN_SECONDS = 60
const MUX_UPLOAD_TIMEOUT_MAX_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_MUX_UPLOAD_TIMEOUT_SECONDS = 60 * 60
const MUX_READY_STATUSES = new Set(['ready'])
const MUX_FAILED_STATUSES = new Set(['errored', 'cancelled', 'timed_out'])
const MUX_LIVE_RTMPS_ENDPOINT = 'rtmps://global-live.mux.com:443/app'
// Default 0: our native publishers do not auto-reconnect a dropped RTMP
// session, so a reconnect window never resumed a recording — it only gave Mux a
// gap to splice its "connection interrupted" slate into the recorded asset
// (e.g. after an ungraceful disconnect or a client crash on stop). With a 0s
// window Mux finalizes the asset at the last frame it received, which freezes on
// that frame instead of ever showing the slate. Overridable via
// MUX_LIVE_RECONNECT_WINDOW_SECONDS if real reconnect support is added later.
const DEFAULT_MUX_LIVE_RECONNECT_WINDOW_SECONDS = 0
const MUX_LIVE_RECONNECT_WINDOW_MAX_SECONDS = 30 * 60
// Grace period past the tier recording limit before Mux force-terminates the
// stream. The client auto-stops at the tier limit; this is the server-side
// backstop for crashed or hostile clients.
const MUX_LIVE_MAX_DURATION_BUFFER_SECONDS = 5 * 60
// Mux accepts max_continuous_duration between 60s and 12h.
const MUX_LIVE_MAX_CONTINUOUS_DURATION_MIN_SECONDS = 60
const MUX_LIVE_MAX_CONTINUOUS_DURATION_MAX_SECONDS = 12 * 60 * 60
// Pending (provisioned but never published) live sessions are reaped after
// this age regardless of client heartbeats. The client expires its preview
// before this deadline, so only abandoned sessions hit the reaper.
export const MAX_PENDING_LIVE_SESSION_AGE_MS = 5 * 60 * 1000
const SIGNED_PLAYBACK_URL_TTL_SECONDS = 12 * 60 * 60
const DURATION_LIMIT_EXCEEDED_STATUS = 'duration_limit_exceeded'
// Reconciliation: how long a record may sit in a non-terminal status before
// the cron re-queries Mux directly. The webhook is the fast path; this is the
// durable fallback for missed/unmatched webhook events.
const STUCK_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000
const STUCK_WAITING_FOR_UPLOAD_THRESHOLD_MS = 30 * 60 * 1000
// A finished live stream whose recorded asset never appears on Mux after this
// long is marked errored instead of spinning on "Processing..." forever.
const STUCK_LIVE_RECORDING_GIVE_UP_MS = 60 * 60 * 1000
// A record stuck in 'waiting_for_upload' this long — whose Mux upload object is
// gone or never resolves — is terminated rather than left as a permanent,
// unreachable orphan. Generous beyond any plausible upload completion (Mux
// direct-upload URLs expire in ~1h) so we never kill an in-flight upload.
const STUCK_WAITING_FOR_UPLOAD_GIVE_UP_MS = 6 * 60 * 60 * 1000
const RECONCILE_BATCH_LIMIT = 25
// The mobile client closes native RTMP before calling endLiveStream, so a short
// wait here is safe. Mux's live_stream.active webhook can lag behind the
// recording asset Mux has already created — with zero wait, endLiveStream
// treated quick stops (common on responses) as "never started" and deleted the
// row.
const MUX_LIVE_ACTIVE_BEFORE_COMPLETE_WAIT_MS = 15_000
// Re-read our own row this often (cheap, local). Confirms the moment Mux's
// active webhook lands without hammering the Mux API.
const MUX_LIVE_ACTIVE_BEFORE_COMPLETE_POLL_MS = 500
// Hit the Mux API at most this often while waiting (plus one final read at the
// deadline). Keeps the wait responsive without ~30 API calls per quick stop.
const MUX_LIVE_ACTIVE_INGEST_CHECK_INTERVAL_MS = 2_500

function getMuxConfig() {
  const tokenId = process.env.MUX_TOKEN_ID
  const tokenSecret = process.env.MUX_TOKEN_SECRET

  if (!tokenId || !tokenSecret) {
    throw new Error(
      'Mux is not configured. Please set MUX_TOKEN_ID and MUX_TOKEN_SECRET in Convex environment variables.',
    )
  }

  return {
    tokenId,
    tokenSecret,
    playbackPolicy: getConfiguredPlaybackPolicy(),
    liveLatencyMode: readLiveLatencyMode(process.env.MUX_LIVE_LATENCY_MODE),
    videoQuality: process.env.MUX_VIDEO_QUALITY ?? 'basic',
    uploadCorsOrigin: process.env.MUX_UPLOAD_CORS_ORIGIN ?? '*',
    reconnectSlateUrl: readMuxSlateUrl(process.env.MUX_LIVE_RECONNECT_SLATE_URL),
    reconnectWindowSeconds: readMuxSeconds(
      process.env.MUX_LIVE_RECONNECT_WINDOW_SECONDS,
      DEFAULT_MUX_LIVE_RECONNECT_WINDOW_SECONDS,
      0,
      MUX_LIVE_RECONNECT_WINDOW_MAX_SECONDS,
    ),
  }
}

// Public image that Mux downloads at the start of each recorded live asset and
// uses as slate media during reconnect-window interruptions.
function readMuxSlateUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('MUX_LIVE_RECONNECT_SLATE_URL must be an absolute HTTP(S) URL.')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('MUX_LIVE_RECONNECT_SLATE_URL must use http or https.')
  }

  return url.toString()
}

function readPlaybackPolicy(value: string | undefined): PlaybackPolicy {
  return value === 'signed' ? 'signed' : 'public'
}

function getConfiguredPlaybackPolicy(): PlaybackPolicy {
  return readPlaybackPolicy(process.env.MUX_PLAYBACK_POLICY)
}

function readLiveLatencyMode(value: string | undefined): LiveLatencyMode {
  return value === 'standard' || value === 'reduced' || value === 'low' ? value : 'low'
}

function readMuxSeconds(
  value: string | undefined,
  defaultSeconds: number,
  minSeconds: number,
  maxSeconds: number,
): number {
  const parsed = value === undefined ? defaultSeconds : Number(value)
  if (!Number.isFinite(parsed)) {
    return defaultSeconds
  }

  return Math.min(maxSeconds, Math.max(minSeconds, Math.trunc(parsed)))
}

function getMuxAuthorizationHeader(tokenId: string, tokenSecret: string): string {
  return `Basic ${btoa(`${tokenId}:${tokenSecret}`)}`
}

function readObject(value: unknown, context = 'Mux API response'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Unexpected ${context}`)
  }

  return value as Record<string, unknown>
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readString(value: unknown, fieldName: string): string {
  const result = readOptionalString(value)
  if (!result) {
    throw new Error(`Mux API response is missing ${fieldName}`)
  }

  return result
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function parseMuxData(payload: unknown): Record<string, unknown> {
  return readObject(readObject(payload).data, 'Mux API data')
}

function getMuxPlaybackId(asset: Record<string, unknown>): string | undefined {
  const playbackIds = asset.playback_ids
  if (!Array.isArray(playbackIds)) {
    return undefined
  }

  for (const playbackId of playbackIds) {
    if (typeof playbackId !== 'object' || playbackId === null || Array.isArray(playbackId)) {
      continue
    }

    const id = readOptionalString((playbackId as Record<string, unknown>).id)
    if (id) {
      return id
    }
  }

  return undefined
}

function readMuxErrorDetail(value: unknown): MuxErrorDetail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const error = value as Record<string, unknown>
  const message = readOptionalString(error.message)
  const messages = [...readStringArray(error.messages), ...(message ? [message] : [])]
  const type = readOptionalString(error.type)
  const code = readOptionalString(error.code)
  if (!type && !code && messages.length === 0) {
    return null
  }

  return {
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    messages: Array.from(new Set(messages)),
  }
}

function readMuxErrorInfo(data: Record<string, unknown>): MuxErrorInfo {
  const details: MuxErrorDetail[] = []
  const errors = data.errors

  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const detail = readMuxErrorDetail(entry)
      if (detail) details.push(detail)
    }
  } else {
    const detail = readMuxErrorDetail(errors)
    if (detail) details.push(detail)
  }

  if (Array.isArray(data.tracks)) {
    for (const track of data.tracks) {
      if (!track || typeof track !== 'object' || Array.isArray(track)) continue
      const detail = readMuxErrorDetail((track as Record<string, unknown>).error)
      if (detail) details.push(detail)
    }
  }

  return {
    message: readOptionalString(data.error_message) ?? details[0]?.messages[0],
    details: details.length > 0 ? details : undefined,
  }
}

function getMuxPlaybackUrl(playbackId: string): string {
  return `https://stream.mux.com/${playbackId}.m3u8`
}

function getMuxThumbnailUrl(playbackId: string): string {
  return `https://image.mux.com/${playbackId}/thumbnail.jpg`
}

function getMuxCaptionsUrl(playbackId: string, trackId: string): string {
  return `https://stream.mux.com/${playbackId}/text/${trackId}.vtt`
}

function getMuxPreviewUrl(playbackId: string): string {
  return `https://image.mux.com/${playbackId}/animated.gif`
}

function base64UrlEncode(input: string | Uint8Array | ArrayBuffer): string {
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input)

  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64ToBytes(value: string): Uint8Array {
  const standard = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(standard)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

function getMuxSigningConfig() {
  const keyId = process.env.MUX_SIGNING_KEY_ID
  const privateKey = process.env.MUX_SIGNING_PRIVATE_KEY

  if (!keyId || !privateKey) {
    throw new Error(
      'Mux signed playback is not configured. Set MUX_SIGNING_KEY_ID and MUX_SIGNING_PRIVATE_KEY in Convex environment variables.',
    )
  }

  return { keyId, privateKey }
}

function readMuxSigningPrivateKey(privateKey: string) {
  const normalizedPrivateKey = privateKey.replace(/\\n/g, '\n').trim()
  if (
    normalizedPrivateKey.includes('-----BEGIN RSA PRIVATE KEY-----') ||
    normalizedPrivateKey.includes('-----BEGIN PRIVATE KEY-----')
  ) {
    return normalizedPrivateKey
  }

  return new TextDecoder().decode(base64ToBytes(normalizedPrivateKey))
}

async function importMuxSigningKey(encodedPrivateKey: string) {
  const pem = readMuxSigningPrivateKey(encodedPrivateKey)
  const isRsaKey = pem.includes('-----BEGIN RSA PRIVATE KEY-----')
  const derBase64 = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  const der = base64ToBytes(derBase64)

  // PKCS1 RSA key format: need to wrap in PKCS8 envelope for Web Crypto
  const keyData: ArrayBuffer = isRsaKey
    ? wrapPkcs1ToPkcs8(der)
    : (der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer)

  return await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

/**
 * Wrap a PKCS1 RSAPrivateKey DER in a PKCS8 PrivateKeyInfo envelope.
 * PKCS8 = SEQUENCE { version(0), algorithm SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }, privateKey OCTET STRING wrapping PKCS1 DER }
 */
function wrapPkcs1ToPkcs8(pkcs1Der: Uint8Array): ArrayBuffer {
  // PKCS8 PrivateKeyInfo header for RSA:
  // SEQUENCE (variable length)
  //   INTEGER 0  (version)
  //   SEQUENCE (13 bytes)
  //     OBJECT IDENTIFIER 1.2.840.113549.1.1.1 (rsaEncryption) = 06 09 2A 86 48 86 F7 0D 01 01 01
  //     NULL = 05 00
  //   OCTET STRING (wrapping PKCS1 key)

  const rsaOid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01])
  const algorithmSeq = encodeSequence(new Uint8Array([...rsaOid, 0x05, 0x00])) // SEQUENCE { OID, NULL }
  const version = new Uint8Array([0x02, 0x01, 0x00]) // INTEGER 0
  const octetStr = encodeOctetString(pkcs1Der)

  const inner = new Uint8Array(version.length + algorithmSeq.length + octetStr.length)
  inner.set(version, 0)
  inner.set(algorithmSeq, version.length)
  inner.set(octetStr, version.length + algorithmSeq.length)

  return encodeSequence(inner).buffer as ArrayBuffer
}

function encodeSequence(content: Uint8Array): Uint8Array {
  const lenBytes = encodeLength(content.length)
  const result = new Uint8Array(1 + lenBytes.length + content.length)
  result[0] = 0x30 // SEQUENCE tag
  result.set(lenBytes, 1)
  result.set(content, 1 + lenBytes.length)
  return result
}

function encodeOctetString(content: Uint8Array): Uint8Array {
  const lenBytes = encodeLength(content.length)
  const result = new Uint8Array(1 + lenBytes.length + content.length)
  result[0] = 0x04 // OCTET STRING tag
  result.set(lenBytes, 1)
  result.set(content, 1 + lenBytes.length)
  return result
}

function encodeLength(len: number): Uint8Array {
  if (len < 128) return new Uint8Array([len])
  const bytes: number[] = []
  let remaining = len
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>>= 8
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes])
}

async function signMuxPlaybackToken(playbackId: string, aud: MuxSignedAudience) {
  const { keyId, privateKey } = getMuxSigningConfig()
  const exp = Math.floor(Date.now() / 1000) + SIGNED_PLAYBACK_URL_TTL_SECONDS
  const header = { alg: 'RS256', typ: 'JWT', kid: keyId }
  const payload = { sub: playbackId, aud, exp, kid: keyId }
  const unsignedToken = [
    base64UrlEncode(JSON.stringify(header)),
    base64UrlEncode(JSON.stringify(payload)),
  ].join('.')
  const key = await importMuxSigningKey(privateKey)
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedToken),
  )

  return [unsignedToken, base64UrlEncode(signature)].join('.')
}

function withMuxToken(url: string, token: string) {
  return `${url}?token=${token}`
}

function parseMuxDurationMs(value: unknown): number | undefined {
  const numberValue =
    typeof value === 'string' && value.length > 0 ? Number(value) : readOptionalNumber(value)
  return typeof numberValue === 'number' && Number.isFinite(numberValue)
    ? Math.round(numberValue * 1000)
    : undefined
}

function assertDurationWithinCampRules(camp: Doc<'camps'>, durationMs: number | undefined) {
  if (durationMs === undefined) {
    return
  }

  if (
    camp.rules?.participation.maxDurationMs &&
    durationMs > camp.rules.participation.maxDurationMs
  ) {
    throwUserError('This recording is longer than the camp allows')
  }
}

async function assertCanCreateInCamp(
  ctx: QueryCtx | MutationCtx,
  args: {
    userId: Id<'users'>
    campId: Id<'camps'>
    durationMs?: number
    tags?: string[]
  },
) {
  return await assertUserCanParticipateInCamp(ctx, { ...args, operation: 'spark' })
}

async function assertCanCreatePersonalBondfire(
  ctx: QueryCtx | MutationCtx,
  args: {
    userId: Id<'users'>
    durationMs?: number
  },
) {
  await assertVideoDurationWithinTierLimit(ctx, args.userId, args.durationMs)

  const tier = await getEntitlementSubscriptionTier(ctx, args.userId)
  if (!PAID_TIERS.includes(tier)) {
    throwUserError('A Hearth requires a Plus, Premium, or Pro subscription.')
  }

  const personalCamp = await ctx.db
    .query('personalCamps')
    .withIndex('by_owner', (q) => q.eq('ownerId', args.userId))
    .first()

  if (!personalCamp) {
    throwUserError('Hearth not found. Subscribe to Plus, Premium, or Pro to create one.')
  }

  if (personalCamp.status !== 'active') {
    throwUserError('Your hearth is currently frozen. Please re-subscribe to reactivate it.')
  }

  return personalCamp
}

async function assertCanViewBondfire(
  ctx: QueryCtx,
  args: { userId: Id<'users'>; bondfire: Doc<'bondfires'> },
) {
  const bondfire = args.bondfire
  if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
    throwUserError('Bondfire not found')
  }

  if (bondfire.personalCampId) {
    if (!(await canViewPersonalBondfire(ctx, { bondfire, userId: args.userId }))) {
      throwUserError('Bondfire not found')
    }
    return
  }

  if (!bondfire.campId) {
    return
  }

  const camp = await ctx.db.get(bondfire.campId)
  if (!camp || !isCampReadableStatus(camp.status)) {
    throwUserError('Camp not found')
  }

  if (!requiresActiveMembershipForVisibility(camp)) {
    return
  }

  const membership = await ctx.db
    .query('campMembers')
    .withIndex('by_user_camp', (q) => q.eq('userId', args.userId).eq('campId', camp._id))
    .first()

  if (membership?.status !== 'active') {
    throwUserError('Bondfire not found')
  }
}

async function assertUserCanParticipateInCamp(
  ctx: QueryCtx | MutationCtx,
  args: {
    userId: Id<'users'>
    campId: Id<'camps'>
    operation: 'spark' | 'response'
    durationMs?: number
    tags?: string[]
  },
): Promise<Doc<'camps'>> {
  const [user, camp] = await Promise.all([ctx.db.get(args.userId), ctx.db.get(args.campId)])
  if (!user) {
    throwUserError('User not found')
  }
  if (!camp || !isCampParticipableStatus(camp.status)) {
    throwUserError('Camp not found')
  }

  const membership = await ctx.db
    .query('campMembers')
    .withIndex('by_user_camp', (q) => q.eq('userId', args.userId).eq('campId', args.campId))
    .first()

  if (membership?.status !== 'active') {
    throwUserError('Join this camp before sparking here')
  }

  if (args.operation === 'spark' && camp.access === 'invite' && camp.ownerId !== args.userId) {
    throwUserError('Only the private camp owner can spark here')
  }

  const campGender = camp.rules?.access.gender?.value
  if (campGender && campGender !== 'any' && user.gender !== campGender) {
    throwUserError('This camp is limited to members who match its gender setting')
  }

  assertDurationWithinCampRules(camp, args.durationMs)

  const allowedTiers = camp.rules?.access?.allowedTiers?.value
  if (args.operation === 'spark' && allowedTiers && allowedTiers.length > 0) {
    const tier = await getEntitlementSubscriptionTier(ctx, args.userId)
    if (!allowedTiers.includes(tier)) {
      throwUserError('Your membership tier cannot spark in this camp')
    }
  }

  if (args.operation === 'spark') {
    await assertCanCreateBondfire(ctx, args.userId)
    await assertVideoDurationWithinTierLimit(ctx, args.userId, args.durationMs)
  }

  if (args.operation === 'spark' && camp.rules?.advisory.requiresTradeTags) {
    const tags = args.tags ?? []
    if (!tags.includes('need') && !tags.includes('offer')) {
      throwUserError('The Trading Post requires a need or offer tag')
    }
  }

  return camp
}

async function assertCanRespondToBondfire(
  ctx: QueryCtx | MutationCtx,
  args: {
    userId: Id<'users'>
    bondfireId: Id<'bondfires'>
    durationMs?: number
  },
): Promise<Doc<'bondfires'>> {
  const bondfire = await ctx.db.get(args.bondfireId)
  if (!bondfire) {
    throwUserError('Bondfire not found')
  }
  if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
    throwUserError('Bondfire not found')
  }

  await assertVideoDurationWithinTierLimit(ctx, args.userId, args.durationMs)

  if (bondfire.personalCampId) {
    await assertCanRespondToPersonalBondfire(ctx, {
      bondfire,
      userId: args.userId,
    })
    return bondfire
  }

  if (!bondfire.campId) {
    return bondfire
  }

  const camp = await assertUserCanParticipateInCamp(ctx, {
    userId: args.userId,
    campId: bondfire.campId,
    operation: 'response',
    durationMs: args.durationMs,
  })

  if (camp.rules?.participation.maxResponses !== undefined) {
    const existingVideos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .collect()
    const activeResponses = existingVideos.filter((video) => video.videoStatus !== 'errored')
    if (activeResponses.length >= camp.rules.participation.maxResponses) {
      throwUserError('This Bondfire already has the maximum number of responses')
    }
  }

  return bondfire
}

/**
 * Hard ceiling on any single Mux API call. Without this, a hung Mux request
 * never settles, the Convex action exhausts its execution budget, and the
 * runtime kills it — surfacing to the client as an opaque "Server Error" that
 * escapes every JS `catch` (so it's also invisible to triage telemetry). An
 * AbortController turns that silent hang into a catchable, loggable, and
 * user-actionable failure. Mux normally responds in well under a second.
 */
const MUX_REQUEST_TIMEOUT_MS = 15_000

async function muxRequest(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = MUX_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const config = getMuxConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${MUX_API_BASE_URL}${path}`, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: getMuxAuthorizationHeader(config.tokenId, config.tokenSecret),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })

    if (!response.ok) {
      const message = await response.text()
      throw new Error(`Mux API request failed: ${response.status} ${message}`)
    }

    return readObject(await response.json())
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Mux API request timed out after ${timeoutMs}ms: ${init.method ?? 'GET'} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Like muxRequest, but returns null on 404 instead of throwing. */
async function muxRequestOptional(path: string): Promise<Record<string, unknown> | null> {
  const config = getMuxConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MUX_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${MUX_API_BASE_URL}${path}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: getMuxAuthorizationHeader(config.tokenId, config.tokenSecret),
      },
    })

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      const message = await response.text()
      throw new Error(`Mux API request failed: ${response.status} ${message}`)
    }

    return readObject(await response.json())
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Mux API request timed out after ${MUX_REQUEST_TIMEOUT_MS}ms: GET ${path}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function deleteMuxAsset(assetId: string): Promise<'deleted' | 'missing'> {
  const config = getMuxConfig()
  const response = await fetch(`${MUX_API_BASE_URL}/assets/${assetId}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
      Authorization: getMuxAuthorizationHeader(config.tokenId, config.tokenSecret),
    },
  })

  if (response.status === 404) {
    return 'missing'
  }

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Mux asset delete failed: ${response.status} ${message}`)
  }

  return 'deleted'
}

async function deleteMuxLiveStream(liveStreamId: string): Promise<'deleted' | 'missing'> {
  const config = getMuxConfig()
  const response = await fetch(`${MUX_API_BASE_URL}/live-streams/${liveStreamId}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
      Authorization: getMuxAuthorizationHeader(config.tokenId, config.tokenSecret),
    },
  })

  if (response.status === 404) {
    return 'missing'
  }

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Mux live stream delete failed: ${response.status} ${message}`)
  }

  return 'deleted'
}

/**
 * Ensure an asset ends up with a caption track feeding the AI pipeline
 * (ai.ts). Checks the asset's tracks and takes exactly one step:
 * - a READY generated text track → schedule processVideoTranscript directly.
 *   This is the deterministic recovery for a track.ready webhook that arrived
 *   before the record had its playback ID, or was missed entirely.
 * - a text track still preparing → nothing; its track.ready webhook drives.
 * - no text track → POST generate-subtitles, but only when requestIfMissing.
 *   Direct uploads request captions at asset creation and the pending track
 *   may not be listed yet at the asset.ready instant — POSTing then would
 *   create a duplicate caption track. Live recordings (which cannot request
 *   at creation) and manual backfill pass requestIfMissing: true.
 */
export const requestGeneratedSubtitles = internalAction({
  args: {
    muxAssetId: v.string(),
    table: v.union(v.literal('bondfires'), v.literal('bondfireVideos')),
    recordId: v.union(v.id('bondfires'), v.id('bondfireVideos')),
    requestIfMissing: v.boolean(),
  },
  handler: async (ctx, args) => {
    const response = await muxRequestOptional(`/assets/${args.muxAssetId}`)
    if (!response) {
      return { action: 'asset_not_found' }
    }

    const asset = readObject(response.data, 'Mux asset')
    const tracks = Array.isArray(asset.tracks)
      ? asset.tracks.map((track) => readObject(track, 'Mux asset track'))
      : []

    const readyTextTrack = tracks.find((track) => track.type === 'text' && track.status === 'ready')
    if (readyTextTrack) {
      await ctx.scheduler.runAfter(0, internal.ai.processVideoTranscript, {
        table: args.table,
        recordId: args.recordId,
        muxAssetId: args.muxAssetId,
        muxTrackId: readString(readyTextTrack.id, 'Mux text track id'),
        languageCode: readOptionalString(readyTextTrack.language_code),
      })
      return { action: 'scheduled_processing' }
    }
    if (tracks.some((track) => track.type === 'text')) {
      return { action: 'text_track_preparing' }
    }
    if (!args.requestIfMissing) {
      return { action: 'skipped_request' }
    }

    const audioTrack = tracks.find((track) => track.type === 'audio')
    if (!audioTrack) {
      return { action: 'no_audio_track' }
    }

    const audioTrackId = readString(audioTrack.id, 'Mux audio track id')
    await muxRequest(`/assets/${args.muxAssetId}/tracks/${audioTrackId}/generate-subtitles`, {
      method: 'POST',
      body: JSON.stringify({ generated_subtitles: [GENERATED_SUBTITLES_SETTINGS] }),
    })
    return { action: 'requested' }
  },
})

/**
 * Backfill AI insights for ready videos that predate the pipeline (or whose
 * processing failed). Records with a stored transcript go straight to
 * summarization; the rest go through requestGeneratedSubtitles, which either
 * processes an existing caption track or requests one (its track.ready
 * webhook then drives the normal flow). Run manually:
 *   npx convex run videos:backfillVideoInsights '{"limit": 25}'
 * Work is staggered a second apart to be gentle on Mux and LLM rate limits.
 */
export const backfillVideoInsights = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const candidates = await ctx.runQuery(internal.ai.listRecordsMissingInsights, {
      limit: args.limit,
    })

    const results: Array<{ recordId: string; action: string }> = []
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.hasTranscript) {
        await ctx.scheduler.runAfter(index * 1_000, internal.ai.processVideoTranscript, {
          table: candidate.table,
          recordId: candidate.recordId,
          muxAssetId: candidate.muxAssetId,
        })
        results.push({ recordId: candidate.recordId, action: 'summarize_stored_transcript' })
      } else {
        await ctx.scheduler.runAfter(index * 1_000, internal.videos.requestGeneratedSubtitles, {
          muxAssetId: candidate.muxAssetId,
          table: candidate.table,
          recordId: candidate.recordId,
          requestIfMissing: true,
        })
        results.push({ recordId: candidate.recordId, action: 'ensure_subtitles' })
      }
    }
    return results
  },
})

/**
 * URL for a text track's plain-text transcript on stream.mux.com, signed when
 * the playback policy requires it. Transcript fetching lives in ai.ts; the
 * signing machinery is private to this module.
 */
export async function buildMuxTranscriptUrl(args: {
  playbackId: string
  trackId: string
  playbackPolicy?: PlaybackPolicy
}): Promise<string> {
  const url = `https://stream.mux.com/${args.playbackId}/text/${args.trackId}.txt`
  if (args.playbackPolicy !== 'signed') {
    return url
  }

  return withMuxToken(url, await signMuxPlaybackToken(args.playbackId, 'v'))
}

export function classifyDisableMuxLiveStreamStatus(
  httpStatus: number,
): DisableMuxLiveStreamOutcome {
  if (httpStatus === 404) return 'missing'
  if (httpStatus >= 200 && httpStatus < 300) return 'disabled'
  return 'error'
}

// Disable a Mux live stream, tolerating an already-gone stream. A 404 resolves
// to 'missing' (the stream is already deleted on Mux) rather than throwing, so
// the stale-session reaper can settle the DB row instead of retrying the same
// dead stream every cron tick forever. Genuinely transient failures (5xx,
// network, timeout) still throw so the caller leaves the row for the next run.
async function disableMuxLiveStream(liveStreamId: string): Promise<'disabled' | 'missing'> {
  const config = getMuxConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MUX_REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${MUX_API_BASE_URL}/live-streams/${liveStreamId}/disable`, {
      method: 'PUT',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: getMuxAuthorizationHeader(config.tokenId, config.tokenSecret),
      },
    })

    const outcome = classifyDisableMuxLiveStreamStatus(response.status)
    if (outcome === 'error') {
      const message = await response.text()
      throw new Error(`Mux live stream disable failed: ${response.status} ${message}`)
    }

    return outcome
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Mux API request timed out after ${MUX_REQUEST_TIMEOUT_MS}ms: PUT /live-streams/${liveStreamId}/disable`,
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function isPlayableVideoRecord(record: {
  videoStatus?: string
  muxPlaybackId?: string
  muxLivePlaybackId?: string
  expiresAt?: number
}) {
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
    return false
  }

  const status = record.videoStatus ?? 'ready'
  return (
    (status === 'ready' && !!record.muxPlaybackId) ||
    (status === 'live' && !!record.muxLivePlaybackId)
  )
}

async function findMuxRecordByUpload(
  ctx: MutationCtx,
  uploadId: string,
): Promise<MuxRecord | null> {
  const bondfire = await ctx.db
    .query('bondfires')
    .withIndex('by_mux_upload', (q) => q.eq('muxUploadId', uploadId))
    .first()
  if (bondfire) {
    return { table: 'bondfires', document: bondfire }
  }

  const responseVideo = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_mux_upload', (q) => q.eq('muxUploadId', uploadId))
    .first()
  return responseVideo ? { table: 'bondfireVideos', document: responseVideo } : null
}

async function findMuxRecordByAsset(ctx: MutationCtx, assetId: string): Promise<MuxRecord | null> {
  const bondfire = await ctx.db
    .query('bondfires')
    .withIndex('by_mux_asset', (q) => q.eq('muxAssetId', assetId))
    .first()
  if (bondfire) {
    return { table: 'bondfires', document: bondfire }
  }

  const responseVideo = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_mux_asset', (q) => q.eq('muxAssetId', assetId))
    .first()
  return responseVideo ? { table: 'bondfireVideos', document: responseVideo } : null
}

async function findMuxRecordByLiveStream(
  ctx: MutationCtx,
  liveStreamId: string,
): Promise<MuxRecord | null> {
  const bondfire = await ctx.db
    .query('bondfires')
    .withIndex('by_live_stream', (q) => q.eq('muxLiveStreamId', liveStreamId))
    .first()
  if (bondfire) {
    return { table: 'bondfires', document: bondfire }
  }

  const responseVideo = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_live_stream', (q) => q.eq('muxLiveStreamId', liveStreamId))
    .first()
  return responseVideo ? { table: 'bondfireVideos', document: responseVideo } : null
}

async function findMuxRecord(
  ctx: MutationCtx,
  args: { uploadId?: string; assetId?: string; liveStreamId?: string },
) {
  if (args.uploadId) {
    const byUpload = await findMuxRecordByUpload(ctx, args.uploadId)
    if (byUpload) {
      return byUpload
    }
  }

  if (args.assetId) {
    const byAsset = await findMuxRecordByAsset(ctx, args.assetId)
    if (byAsset) {
      return byAsset
    }
  }

  if (args.liveStreamId) {
    return await findMuxRecordByLiveStream(ctx, args.liveStreamId)
  }

  return null
}

async function markRecordAssetCreated(
  ctx: MutationCtx,
  record: MuxRecord,
  args: { assetId: string; assetStatus?: string },
) {
  const patch = {
    muxAssetId: args.assetId,
    muxAssetStatus: args.assetStatus ?? 'preparing',
    videoStatus: 'processing' as const,
  }

  if (record.table === 'bondfires') {
    await ctx.db.patch(record.document._id, {
      ...patch,
      updatedAt: Date.now(),
    })
  } else {
    await ctx.db.patch(record.document._id, patch)
  }
}

async function assertMuxMetadataDurationAllowed(
  ctx: MutationCtx,
  record: MuxRecord,
  durationMs: number | undefined,
) {
  await assertVideoDurationWithinTierLimit(ctx, record.document.userId, durationMs)

  if (durationMs === undefined) {
    return
  }

  const campId =
    record.table === 'bondfires'
      ? record.document.campId
      : (await ctx.db.get(record.document.bondfireId))?.campId
  if (!campId) {
    return
  }

  const camp = await ctx.db.get(campId)
  if (camp) {
    assertDurationWithinCampRules(camp, durationMs)
  }
}

async function markRecordReady(
  ctx: MutationCtx,
  record: MuxRecord,
  args: {
    assetId: string
    playbackId: string
    playbackPolicy?: PlaybackPolicy
    assetStatus?: string
    durationMs?: number
    muxAspectRatio?: string
    muxMaxResolution?: string
  },
): Promise<'ready' | 'rejected'> {
  try {
    await assertMuxMetadataDurationAllowed(ctx, record, args.durationMs)
  } catch {
    await markRecordErrored(ctx, record, {
      assetId: args.assetId,
      assetStatus: DURATION_LIMIT_EXCEEDED_STATUS,
      durationMs: args.durationMs,
    })
    return 'rejected'
  }

  const wasReady = (record.document.videoStatus ?? 'ready') === 'ready'
  if (!wasReady) {
    // Ensure the asset ends up with a caption track feeding the AI pipeline.
    // Covers every path to 'ready' (webhook, poller, reconciler). Only live
    // recordings may POST generate-subtitles here — direct uploads requested
    // captions at asset creation, and their pending track may not be visible
    // yet, so a POST would duplicate it.
    await ctx.scheduler.runAfter(0, internal.videos.requestGeneratedSubtitles, {
      muxAssetId: args.assetId,
      table: record.table,
      recordId: record.document._id,
      requestIfMissing: record.document.liveSessionId !== undefined,
    })
  }
  const patch = {
    videoStatus: 'ready' as const,
    muxAssetStatus: args.assetStatus ?? 'ready',
    muxAssetId: args.assetId,
    muxPlaybackId: args.playbackId,
    muxPlaybackPolicy: args.playbackPolicy ?? record.document.muxPlaybackPolicy,
    muxAspectRatio: args.muxAspectRatio,
    muxMaxResolution: args.muxMaxResolution,
    durationMs: args.durationMs ?? record.document.durationMs,
  }

  if (record.table === 'bondfires') {
    await ctx.db.patch(record.document._id, {
      ...patch,
      updatedAt: Date.now(),
    })

    if (!wasReady) {
      const user = await ctx.db.get(record.document.userId)
      if (user) {
        await ctx.db.patch(record.document.userId, {
          bondfireCount: (user.bondfireCount ?? 0) + 1,
          updatedAt: Date.now(),
        })
      }

      if (record.document.campId) {
        const camp = await ctx.db.get(record.document.campId)
        if (camp) {
          await ctx.db.patch(record.document.campId, {
            bondfireCount: (camp.bondfireCount ?? 0) + 1,
            updatedAt: Date.now(),
          })
        }
      }
      if (!record.document.liveSessionId) {
        await ctx.scheduler.runAfter(0, internal.sendNotification.notifyCampBondfire, {
          bondfireId: record.document._id,
          creatorId: record.document.userId,
          creatorName: user?.displayName ?? user?.name ?? 'Someone',
        })
      }
    }
    return 'ready'
  }

  await ctx.db.patch(record.document._id, patch)

  if (wasReady) {
    return 'ready'
  }

  // Live responses are normally counted at the live_stream.active webhook;
  // this covers upload responses and any live row whose 'active' event was
  // missed. Idempotent via countedAt either way.
  await countResponse(ctx, record.document)

  if (record.document.liveSessionId) {
    // Live responses were already announced at stream-watchable.
    return 'ready'
  }

  const [user, bondfire] = await Promise.all([
    ctx.db.get(record.document.userId),
    ctx.db.get(record.document.bondfireId),
  ])

  if (bondfire) {
    await ctx.scheduler.runAfter(0, internal.sendNotification.notifyBondfireResponse, {
      bondfireId: record.document.bondfireId,
      responderId: record.document.userId,
      responderName: user?.displayName ?? user?.name ?? 'Someone',
      bondfireVideoId: record.document._id,
    })
  }

  return 'ready'
}

async function markRecordErrored(
  ctx: MutationCtx,
  record: MuxRecord,
  args: { assetId?: string; assetStatus?: string; durationMs?: number; muxErrorMessage?: string },
) {
  const patch = {
    videoStatus: 'errored' as const,
    muxAssetId: args.assetId,
    muxAssetStatus: args.assetStatus ?? 'errored',
    durationMs: args.durationMs,
  }

  if (record.table === 'bondfires') {
    await ctx.db.patch(record.document._id, {
      ...patch,
      updatedAt: Date.now(),
    })

    // A spark whose recording terminally failed must never remain a reachable
    // "isn't available" dead end. Capture forensics and (when enabled) delete it.
    const errored = await ctx.db.get(record.document._id)
    if (errored) {
      const reason: BondfireFailureReason =
        args.assetStatus === DURATION_LIMIT_EXCEEDED_STATUS
          ? 'duration_limit_exceeded'
          : 'recording_errored'
      const result = await handleFailedBondfire(ctx, errored, reason, {
        assetStatus: args.assetStatus,
        muxErrorMessage: args.muxErrorMessage,
        durationMs: args.durationMs,
        source: 'markRecordErrored',
      })
      if (result.deleted && result.muxAssetIds.length > 0) {
        await ctx.scheduler.runAfter(
          0,
          internal.bondfireFailureCleanup.deleteFailedBondfireMuxAssets,
          { assetIds: result.muxAssetIds },
        )
      }
    }
  } else {
    // Uncount using the pre-patch document so countedAt is still visible.
    await uncountResponse(ctx, record.document)
    await ctx.db.patch(record.document._id, patch)
  }

  // Mirror Mux's error message on the live session so the row itself
  // (not just the client log) tells us *why* the asset was rejected.
  // bondfires/bondfireVideos don't have an errorMessage field; the
  // clientLogs entry from the caller carries the same payload.
  const liveSessionId = record.document.liveSessionId
  if (liveSessionId) {
    const liveSession = await ctx.db.get(liveSessionId)
    if (liveSession && liveSession.errorMessage == null) {
      const reason =
        args.muxErrorMessage ??
        (args.assetStatus
          ? args.assetStatus === 'cancelled'
            ? 'upload cancelled'
            : args.assetStatus === 'timed_out'
              ? 'upload timed out'
              : args.assetStatus === 'errored'
                ? 'Mux rejected the upload'
                : `Mux asset ${args.assetStatus}`
          : 'Mux rejected the upload')
      await ctx.db.patch(liveSession._id, {
        errorMessage: reason,
        updatedAt: Date.now(),
      })
    }
  }
}

// Fields shared by `bondfires` and `bondfireVideos` that we patch in response
// to live-session state transitions. Narrowing the type prevents accidental
// patches with fields that only exist on one of the two tables.
type LiveLinkedRecordPatch = {
  videoStatus?: 'waiting_for_upload' | 'processing' | 'live' | 'ready' | 'errored'
  muxAssetStatus?: string
  muxAssetId?: string
}

// Shared subset of Convex ctx that only needs `db.get` — used by
// helpers reachable from both query and mutation contexts.
type DbReadCtx = { db: { get: MutationCtx['db']['get'] } }

// Shared subset of Convex ctx that needs both `db.get` and `db.patch`.
type DbWriteCtx = {
  db: { get: MutationCtx['db']['get']; patch: MutationCtx['db']['patch'] }
}

async function patchLinkedLiveRecord(
  ctx: DbWriteCtx,
  liveSession: Doc<'liveSessions'>,
  patch: LiveLinkedRecordPatch,
) {
  // The linked record may already be gone — a cancelled session deletes its
  // bondfire/bondfireVideo, and the stale-session reaper still runs afterward.
  // Convex throws on patching a nonexistent id, which would roll back the whole
  // reap (leaving the session wedged forever), so check existence first.
  if (liveSession.bondfireVideoId) {
    const video = await ctx.db.get(liveSession.bondfireVideoId)
    if (video) {
      await ctx.db.patch(liveSession.bondfireVideoId, patch)
    }
    return
  }

  if (liveSession.bondfireId) {
    const bondfire = await ctx.db.get(liveSession.bondfireId)
    if (bondfire) {
      await ctx.db.patch(liveSession.bondfireId, {
        ...patch,
        updatedAt: Date.now(),
      })
    }
  }
}

async function getLinkedLiveRecord(
  ctx: DbReadCtx,
  liveSession: Doc<'liveSessions'>,
): Promise<Doc<'bondfires'> | Doc<'bondfireVideos'> | null> {
  if (liveSession.bondfireVideoId) {
    return await ctx.db.get(liveSession.bondfireVideoId)
  }
  if (liveSession.bondfireId) {
    return await ctx.db.get(liveSession.bondfireId)
  }
  return null
}

// The recorded VOD asset has already resolved for this record. muxPlaybackId
// is only ever written by markRecordReady (live playback uses the separate
// muxLivePlaybackId field), so these two fields together mean the asset.ready
// webhook (or the VOD poller) already succeeded.
function hasResolvedRecordedAsset(record: { muxAssetId?: string; muxPlaybackId?: string }) {
  return !!record.muxAssetId && !!record.muxPlaybackId
}

async function markLinkedLiveRecordProcessing(ctx: MutationCtx, liveSession: Doc<'liveSessions'>) {
  const record = await getLinkedLiveRecord(ctx, liveSession)
  if (!record || (record.videoStatus ?? 'ready') !== 'live') {
    return
  }

  // Mux webhooks are not delivered in order: asset.ready can arrive before
  // the stream's own active/idle events. When that happens the 'active'
  // handler clobbers the ready record back to 'live'. Restore 'ready' here
  // instead of demoting to 'processing' — the asset.ready webhook already
  // fired, so nothing would ever re-promote a demoted record.
  if (hasResolvedRecordedAsset(record)) {
    await patchLinkedLiveRecord(ctx, liveSession, {
      videoStatus: 'ready',
      muxAssetStatus: 'ready',
    })
    return
  }

  await patchLinkedLiveRecord(ctx, liveSession, {
    videoStatus: 'processing',
    muxAssetStatus: 'processing',
  })
}

async function markLinkedLiveRecordErrored(ctx: MutationCtx, liveSession: Doc<'liveSessions'>) {
  // Never went live → no recorded asset will arrive, so mark the bondfire
  // permanently errored. Already went live → the playback URL is dead, so
  // demote it to 'processing' and let the recorded-asset webhook either
  // promote it to 'ready' or mark it errored later.
  if (liveSession.startedAt) {
    await patchLinkedLiveRecord(ctx, liveSession, {
      videoStatus: 'processing',
      muxAssetStatus: 'processing',
    })
    return
  }

  // Give back any count this response holds so the thread doesn't
  // permanently show a response nobody can swipe to.
  if (liveSession.bondfireVideoId) {
    const video = await ctx.db.get(liveSession.bondfireVideoId)
    if (video) {
      await uncountResponse(ctx, video)
    }
  }

  await patchLinkedLiveRecord(ctx, liveSession, {
    videoStatus: 'errored',
    muxAssetStatus: 'errored',
  })

  // A spark live recording that never went live has no recoverable video and
  // must not linger as an unreachable "isn't available" dead end. Capture
  // forensics and (when enabled) delete it. Responses are handled by their own
  // thread/uncount logic above, so only act on sparks here.
  if (liveSession.bondfireId && !liveSession.bondfireVideoId) {
    const spark = await ctx.db.get(liveSession.bondfireId)
    if (spark) {
      const result = await handleFailedBondfire(ctx, spark, 'live_never_watchable', {
        liveSessionId: liveSession._id,
        liveSessionStatus: liveSession.status,
        liveSessionErrorMessage: liveSession.errorMessage,
        source: 'markLinkedLiveRecordErrored',
      })
      if (result.deleted && result.muxAssetIds.length > 0) {
        await ctx.scheduler.runAfter(
          0,
          internal.bondfireFailureCleanup.deleteFailedBondfireMuxAssets,
          { assetIds: result.muxAssetIds },
        )
      }
    }
  }
}

function readMuxAssetInfo(asset: Record<string, unknown>) {
  const playbackId = getMuxPlaybackId(asset)
  return {
    assetId: readString(asset.id, 'asset id'),
    playbackId,
    assetStatus: readOptionalString(asset.status),
    durationMs: parseMuxDurationMs(asset.duration),
    muxAspectRatio: readOptionalString(asset.aspect_ratio),
    muxMaxResolution: readOptionalString(asset.max_stored_resolution),
  }
}

export const createMuxDirectUpload = action({
  args: {
    filename: v.string(),
    contentType: v.string(),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    personalCamp: v.optional(v.boolean()),
    tags: v.optional(v.array(v.string())),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<MuxDirectUploadResult> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    let playbackPolicy: PlaybackPolicy
    if (args.isResponse) {
      if (!args.bondfireId) {
        throwUserError('A bondfire ID is required when uploading a response')
      }

      const policy = await ctx.runQuery(internal.videos.getMuxPlaybackPolicyForNewRecord, {
        userId,
        isResponse: args.isResponse,
        bondfireId: args.bondfireId,
        durationMs: args.durationMs,
      })
      playbackPolicy = policy.playbackPolicy
    } else if (args.personalCamp) {
      await ctx.runQuery(internal.videos.validatePersonalCreateForUser, {
        userId,
        durationMs: args.durationMs,
      })
      playbackPolicy = 'signed'
    } else {
      if (!args.campId) {
        throwUserError('Choose a camp before sparking a Bondfire')
      }

      const policy = await ctx.runQuery(internal.videos.getMuxPlaybackPolicyForNewRecord, {
        userId,
        isResponse: args.isResponse,
        campId: args.campId,
        durationMs: args.durationMs,
        tags: args.tags,
      })
      playbackPolicy = policy.playbackPolicy
    }

    const config = getMuxConfig()
    const uploadTimeout = readMuxSeconds(
      process.env.MUX_UPLOAD_TIMEOUT_SECONDS,
      DEFAULT_MUX_UPLOAD_TIMEOUT_SECONDS,
      MUX_UPLOAD_TIMEOUT_MIN_SECONDS,
      MUX_UPLOAD_TIMEOUT_MAX_SECONDS,
    )
    const payload = {
      cors_origin: config.uploadCorsOrigin,
      timeout: uploadTimeout,
      new_asset_settings: {
        playback_policies: [playbackPolicy],
        video_quality: config.videoQuality,
        // Auto-generated captions: viewers get CC, and the track.ready webhook
        // feeds the transcript → summary/tags pipeline in ai.ts. Included in
        // standard Mux encoding charges. Live recordings can't request this at
        // creation; markRecordReady covers them via requestGeneratedSubtitles.
        inputs: [{ generated_subtitles: [GENERATED_SUBTITLES_SETTINGS] }],
        passthrough: JSON.stringify({
          userId,
          isResponse: args.isResponse,
          bondfireId: args.bondfireId,
          campId: args.campId,
          tags: args.tags,
          filename: args.filename,
          contentType: args.contentType,
        }),
      },
    }

    const data = parseMuxData(
      await muxRequest('/uploads', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    )
    const uploadId = readString(data.id, 'upload id')
    const uploadUrl = readString(data.url, 'upload url')
    const expiresIn = readOptionalNumber(data.timeout) ?? payload.timeout

    const pendingRecord: {
      recordId: Id<'bondfires'> | Id<'bondfireVideos'>
      recordType: 'bondfire' | 'response'
    } = await ctx.runMutation(internal.videos.createPendingMuxVideo, {
      userId,
      uploadId,
      isResponse: args.isResponse,
      bondfireId: args.bondfireId,
      campId: args.campId,
      personalCamp: args.personalCamp,
      tags: args.tags,
      playbackPolicy,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
    })

    return {
      uploadId,
      uploadUrl,
      recordId: pendingRecord.recordId,
      recordType: pendingRecord.recordType,
      expiresIn,
    }
  },
})

export const getMuxUploadStatus = action({
  args: {
    uploadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    const upload = parseMuxData(await muxRequest(`/uploads/${args.uploadId}`))
    const uploadStatus = readOptionalString(upload.status) ?? 'waiting'
    const assetId = readOptionalString(upload.asset_id)
    let assetStatus: string | undefined
    let playbackId: string | undefined
    let durationMs: number | undefined
    let muxAspectRatio: string | undefined
    let muxMaxResolution: string | undefined

    if (assetId) {
      await ctx.runMutation(internal.videos.markMuxAssetCreated, {
        uploadId: args.uploadId,
        assetId,
        assetStatus: 'preparing',
      })

      const asset = parseMuxData(await muxRequest(`/assets/${assetId}`))
      const assetInfo = readMuxAssetInfo(asset)
      assetStatus = assetInfo.assetStatus
      playbackId = assetInfo.playbackId
      durationMs = assetInfo.durationMs
      muxAspectRatio = assetInfo.muxAspectRatio
      muxMaxResolution = assetInfo.muxMaxResolution

      if (assetStatus && MUX_READY_STATUSES.has(assetStatus) && playbackId) {
        const result: { updated: boolean; rejected?: boolean } = await ctx.runMutation(
          internal.videos.markMuxAssetReady,
          {
            uploadId: args.uploadId,
            assetId,
            playbackId,
            assetStatus,
            durationMs,
            muxAspectRatio,
            muxMaxResolution,
          },
        )
        if (result.rejected) {
          assetStatus = DURATION_LIMIT_EXCEEDED_STATUS
          playbackId = undefined
        }
      } else if (assetStatus && MUX_FAILED_STATUSES.has(assetStatus)) {
        await ctx.runMutation(internal.videos.markMuxAssetErrored, {
          uploadId: args.uploadId,
          assetId,
          assetStatus,
        })
      }
    } else if (MUX_FAILED_STATUSES.has(uploadStatus)) {
      await ctx.runMutation(internal.videos.markMuxAssetErrored, {
        uploadId: args.uploadId,
        assetStatus: uploadStatus,
      })
    }

    return {
      uploadStatus,
      assetStatus,
      assetId,
      playbackId,
      isReady: !!playbackId && assetStatus !== undefined && MUX_READY_STATUSES.has(assetStatus),
      isFailed:
        MUX_FAILED_STATUSES.has(uploadStatus) ||
        (assetStatus !== undefined &&
          (MUX_FAILED_STATUSES.has(assetStatus) || assetStatus === DURATION_LIMIT_EXCEEDED_STATUS)),
    }
  },
})

export const isUserAdmin = internalQuery({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId)
    return user?.isAdmin === true
  },
})

export const listExpiredPrivateCampVideoCleanupBatch = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ExpiredPrivateCampVideoCleanupBatch> => {
    const now = Date.now()
    const limit = args.limit ?? 100
    const expiredBondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_expires_at', (q) => q.gt('expiresAt', 0).lte('expiresAt', now))
      .take(limit)
    const muxAssetIds = new Set<string>()

    for (const bondfire of expiredBondfires) {
      if (bondfire.muxAssetId) {
        muxAssetIds.add(bondfire.muxAssetId)
      }

      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      for (const response of responses) {
        if (response.muxAssetId) {
          muxAssetIds.add(response.muxAssetId)
        }
      }
    }

    return {
      bondfireIds: expiredBondfires.map((bondfire) => bondfire._id),
      muxAssetIds: [...muxAssetIds],
      expiredBondfires: expiredBondfires.length,
      remainingMayExist: expiredBondfires.length === limit,
    }
  },
})

export const deleteExpiredPrivateCampVideoRecords = internalMutation({
  args: {
    bondfireIds: v.array(v.id('bondfires')),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const affectedUsers = new Set<Id<'users'>>()
    const affectedCamps = new Set<Id<'camps'>>()
    let deletedBondfires = 0
    let deletedResponses = 0

    for (const bondfireId of args.bondfireIds) {
      const bondfire = await ctx.db.get(bondfireId)
      if (!bondfire || !bondfire.expiresAt || bondfire.expiresAt > now) {
        continue
      }

      affectedUsers.add(bondfire.userId)
      if (bondfire.campId) {
        affectedCamps.add(bondfire.campId)
      }

      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      for (const response of responses) {
        affectedUsers.add(response.userId)
        await ctx.db.delete(response._id)
        deletedResponses += 1
      }

      await ctx.db.delete(bondfire._id)
      deletedBondfires += 1
    }

    for (const campId of affectedCamps) {
      const campBondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_camp', (q) => q.eq('campId', campId))
        .collect()

      await ctx.db.patch(campId, {
        bondfireCount: campBondfires.filter(isPlayableVideoRecord).length,
        updatedAt: now,
      })
    }

    for (const affectedUserId of affectedUsers) {
      const [userBondfires, userResponses] = await Promise.all([
        ctx.db
          .query('bondfires')
          .withIndex('by_user', (q) => q.eq('userId', affectedUserId))
          .collect(),
        ctx.db
          .query('bondfireVideos')
          .withIndex('by_user', (q) => q.eq('userId', affectedUserId))
          .collect(),
      ])

      await ctx.db.patch(affectedUserId, {
        bondfireCount: userBondfires.filter(isPlayableVideoRecord).length,
        responseCount: userResponses.filter(isPlayableVideoRecord).length,
        updatedAt: now,
      })
    }

    return {
      deletedBondfires,
      deletedResponses,
    }
  },
})

export const cleanupExpiredPrivateCampVideos = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ExpiredPrivateCampVideoCleanupResult> => {
    const batch: ExpiredPrivateCampVideoCleanupBatch = await ctx.runQuery(
      internal.videos.listExpiredPrivateCampVideoCleanupBatch,
      { limit: args.limit },
    )

    if (args.dryRun) {
      return {
        expiredBondfires: batch.expiredBondfires,
        muxAssetsToDelete: batch.muxAssetIds.length,
        remainingMayExist: batch.remainingMayExist,
      }
    }

    let deletedMuxAssets = 0
    let missingMuxAssets = 0

    for (const assetId of batch.muxAssetIds) {
      const result = await deleteMuxAsset(assetId)
      if (result === 'missing') {
        missingMuxAssets += 1
      } else {
        deletedMuxAssets += 1
      }
    }

    const deletedRecords: {
      deletedBondfires: number
      deletedResponses: number
    } = await ctx.runMutation(internal.videos.deleteExpiredPrivateCampVideoRecords, {
      bondfireIds: batch.bondfireIds,
    })

    return {
      ...deletedRecords,
      deletedMuxAssets,
      missingMuxAssets,
      remainingMayExist: batch.remainingMayExist,
    }
  },
})

export const createLiveStream = action({
  args: {
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    personalCamp: v.optional(v.boolean()),
    tags: v.optional(v.array(v.string())),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    title: v.optional(v.string()),
    pending: v.optional(v.boolean()),
  },
  handler: (ctx, args): Promise<MuxLiveStreamResult> =>
    withUserFacingActionErrors(
      ctx,
      'videos.createLiveStream',
      'Something went wrong starting your recording. Please try again.',
      async () => {
        const userId = await auth.getUserId(ctx)
        if (!userId) {
          throwUserError('Not authenticated')
        }

        const resolvePlaybackPolicy = async (): Promise<PlaybackPolicy> => {
          if (args.isResponse) {
            if (!args.bondfireId) {
              throwUserError('A bondfire ID is required when creating a live response')
            }

            const policy = await ctx.runQuery(internal.videos.getMuxPlaybackPolicyForNewRecord, {
              userId,
              isResponse: args.isResponse,
              bondfireId: args.bondfireId,
            })
            return policy.playbackPolicy
          }
          if (args.personalCamp) {
            await ctx.runQuery(internal.videos.validatePersonalCreateForUser, { userId })
            return 'signed'
          }
          if (!args.campId) {
            throwUserError('Choose a camp before sparking a Bondfire')
          }

          const policy = await ctx.runQuery(internal.videos.getMuxPlaybackPolicyForNewRecord, {
            userId,
            isResponse: args.isResponse,
            campId: args.campId,
            tags: args.tags,
          })
          return policy.playbackPolicy
        }

        // The three pre-flight reads are independent — run them concurrently.
        // This action sits on the record-tap critical path, so every serial
        // round-trip here is user-visible latency before recording starts.
        const [playbackPolicy, existingActive, maxContinuousDuration] = await Promise.all([
          resolvePlaybackPolicy(),
          // Refuse to provision a billable Mux live stream while the user
          // already has one in flight. The cron will sweep abandoned sessions,
          // but this prevents a runaway loop from creating an unbounded number
          // of them.
          ctx.runQuery(internal.videos.getActiveMuxLiveSessionForUser, { userId }),
          ctx.runQuery(internal.videos.getLiveMaxContinuousDurationSeconds, { userId }),
        ])
        if (existingActive) {
          throwUserError(
            'You already have an active live stream. End it before starting a new one.',
          )
        }

        const config = getMuxConfig()
        const reconnectWindow = config.reconnectWindowSeconds
        const reconnectSlateUrl =
          reconnectWindow > 0 && config.reconnectSlateUrl ? config.reconnectSlateUrl : undefined
        const useSlateForStandardLatency =
          config.liveLatencyMode === 'standard' && reconnectWindow > 0
        const data = parseMuxData(
          await muxRequest('/live-streams', {
            method: 'POST',
            body: JSON.stringify({
              playback_policies: [playbackPolicy],
              latency_mode: config.liveLatencyMode,
              reconnect_window: reconnectWindow,
              max_continuous_duration: maxContinuousDuration,
              // Slate plumbing only engages when a reconnect window is
              // explicitly re-enabled (window defaults to 0, which suppresses any
              // slate and freezes the asset on the last received frame). When a
              // window is configured, replace Mux's default slate with the
              // branded Bondfires image if one is set.
              ...(reconnectSlateUrl ? { reconnect_slate_url: reconnectSlateUrl } : {}),
              // Standard-latency streams don't insert slate media unless this is
              // enabled; all latency modes require reconnect_window > 0.
              ...(useSlateForStandardLatency ? { use_slate_for_standard_latency: true } : {}),
              passthrough: JSON.stringify({
                userId,
                isResponse: args.isResponse,
                bondfireId: args.bondfireId,
                personalCamp: args.personalCamp,
                source: 'bondfires-live',
              }),
              new_asset_settings: {
                playback_policies: [playbackPolicy],
                video_quality: config.videoQuality,
              },
            }),
          }),
        )
        const liveStreamId = readString(data.id, 'live stream id')
        const streamKey = readString(data.stream_key, 'stream key')
        const playbackId = getMuxPlaybackId(data)

        let pendingRecord: {
          liveSessionId: Id<'liveSessions'>
          recordId: Id<'bondfires'> | Id<'bondfireVideos'>
          recordType: 'bondfire' | 'response'
        }

        try {
          pendingRecord = await ctx.runMutation(internal.videos.createLinkedMuxLiveSession, {
            userId,
            liveStreamId,
            playbackId,
            isResponse: args.isResponse,
            bondfireId: args.bondfireId,
            campId: args.campId,
            personalCamp: args.personalCamp,
            playbackPolicy,
            latencyMode: config.liveLatencyMode,
            tags: args.tags,
            width: args.width,
            height: args.height,
            title: args.title,
            pending: args.pending,
          })
        } catch (error) {
          try {
            await deleteMuxLiveStream(liveStreamId)
          } catch (deleteError) {
            console.warn(
              'Failed to delete Mux live stream after Convex linking failed:',
              deleteError,
            )
          }
          throw error
        }

        return {
          liveStreamId,
          liveSessionId: pendingRecord.liveSessionId,
          playbackId,
          ingest: {
            rtmpsUrl: MUX_LIVE_RTMPS_ENDPOINT,
            streamKey,
          },
          playbackUrl:
            playbackPolicy === 'public' && playbackId ? getMuxPlaybackUrl(playbackId) : undefined,
          recordId: pendingRecord.recordId,
          recordType: pendingRecord.recordType,
        }
      },
    ),
})

// Ask Mux directly. Mux's API often knows ingest happened before the
// live_stream.active webhook reaches us, so this is the fast confirmation path
// for quick stops. A null response (network error or 404) means we cannot
// prove the stream was empty — classifyMuxIngest returns 'unknown' so the
// caller preserves the record instead of deleting a recording we failed to see.
// The pure decision logic lives in ./lib/liveIngest (unit-tested separately).
async function classifyMuxLiveStreamIngest(liveStreamId: string): Promise<IngestEvidence> {
  let liveStream: Record<string, unknown> | null
  try {
    liveStream = await muxRequestOptional(`/live-streams/${liveStreamId}`)
  } catch (error) {
    console.warn('Failed to read Mux live stream ingest evidence:', error)
    return classifyMuxIngest({ reachable: false })
  }

  if (!liveStream) {
    return classifyMuxIngest({ reachable: false })
  }

  const liveData = parseMuxData(liveStream)
  return classifyMuxIngest({
    reachable: true,
    status: readOptionalString(liveData.status),
    activeAssetId: readOptionalString(liveData.active_asset_id),
    recentAssetIds: readStringArray(liveData.recent_asset_ids),
  })
}

async function waitForLiveSessionToStart(
  ctx: ActionCtx,
  userId: Id<'users'>,
  liveSessionId: Id<'liveSessions'>,
): Promise<{ session: Doc<'liveSessions'> | null; ingest: IngestEvidence; waitedMs: number }> {
  const start = Date.now()
  const deadline = start + MUX_LIVE_ACTIVE_BEFORE_COMPLETE_WAIT_MS
  let session: Doc<'liveSessions'> | null = await ctx.runQuery(
    internal.videos.getMuxLiveSessionForUser,
    { userId, liveSessionId },
  )
  let lastMuxCheckAt = 0

  while (session) {
    // Cheap local check on every iteration — no Mux API call.
    const local = localIngestSource(session)
    if (local) {
      return {
        session,
        ingest: { status: 'confirmed', source: local },
        waitedMs: Date.now() - start,
      }
    }

    const now = Date.now()
    const timedOut = now >= deadline
    // Throttle Mux API reads to ~1 every few seconds instead of one per poll,
    // but always do a final authoritative read at the deadline.
    const muxCheckDue = now - lastMuxCheckAt >= MUX_LIVE_ACTIVE_INGEST_CHECK_INTERVAL_MS

    if (muxCheckDue || timedOut) {
      lastMuxCheckAt = now
      const ingest = session.muxLiveStreamId
        ? await classifyMuxLiveStreamIngest(session.muxLiveStreamId)
        : ({ status: 'empty', source: 'no_live_stream_id' } as IngestEvidence)
      if (ingest.status === 'confirmed' || timedOut) {
        return { session, ingest, waitedMs: Date.now() - start }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, MUX_LIVE_ACTIVE_BEFORE_COMPLETE_POLL_MS))
    session = await ctx.runQuery(internal.videos.getMuxLiveSessionForUser, {
      userId,
      liveSessionId,
    })
  }

  return {
    session: null,
    ingest: { status: 'empty', source: 'session_gone' },
    waitedMs: Date.now() - start,
  }
}

export const endLiveStream = action({
  args: {
    liveSessionId: v.id('liveSessions'),
    reason: v.optional(v.string()),
  },
  handler: (ctx, args): Promise<EndLiveStreamResult> =>
    withUserFacingActionErrors(
      ctx,
      'videos.endLiveStream',
      'Something went wrong ending your recording. Please try again.',
      async () => {
        const userId = await auth.getUserId(ctx)
        if (!userId) {
          throwUserError('Not authenticated')
        }

        const liveSession: Doc<'liveSessions'> | null = await ctx.runQuery(
          internal.videos.getMuxLiveSessionForUser,
          {
            userId,
            liveSessionId: args.liveSessionId,
          },
        )

        if (!liveSession) {
          throwUserError('Live session not found')
        }

        // Idempotent double-stop. A retried or duplicate stop (flaky network,
        // double tap) must not re-run completion/teardown on an already-finalized
        // session. Answer from persisted state instead of touching Mux again.
        if (
          liveSession.status === 'ending' ||
          liveSession.status === 'ended' ||
          liveSession.status === 'errored'
        ) {
          await ctx.runMutation(internal.serverTelemetry.recordServerEvent, {
            level: 'breadcrumb',
            event: 'live:end_already_finalized',
            message: `endLiveStream called on already-${liveSession.status} session`,
            userId,
            data: {
              liveSessionId: args.liveSessionId,
              status: liveSession.status,
            },
          })

          return {
            ended: liveSession.status !== 'errored',
            completeSignaled: false,
            recordingStarted: Boolean(localIngestSource(liveSession)),
          }
        }

        const {
          session: activeSession,
          ingest,
          waitedMs,
        } = await waitForLiveSessionToStart(ctx, userId, args.liveSessionId)
        if (!activeSession) {
          throwUserError('Live session not found')
        }

        if (ingest.status === 'empty') {
          // Mux is authoritative and confirms the stream never received media.
          // This is the only case where deleting the record is safe.
          await ctx.runMutation(internal.serverTelemetry.recordServerEvent, {
            level: 'warn',
            event: 'live:complete_not_active',
            message: 'Live stream was stopped before Mux confirmed ingest',
            userId,
            data: {
              liveSessionId: args.liveSessionId,
              status: activeSession.status,
              source: ingest.source,
              waitedMs,
              ageMs: Date.now() - activeSession.createdAt,
            },
          })

          try {
            await deleteMuxLiveStream(activeSession.muxLiveStreamId)
          } catch (error) {
            console.warn('Failed to delete never-active Mux live stream:', error)
          }

          await ctx.runMutation(internal.videos.cancelMuxLiveSessionRecord, {
            userId,
            liveSessionId: args.liveSessionId,
            reason: 'stopped_before_live_stream_active',
          })

          return { ended: false, completeSignaled: false, recordingStarted: false }
        }

        // Finalize the recording. `completeSignaled` reports whether we believe
        // Mux will finalize the recorded asset (explicitly or implicitly), not
        // strictly that a /complete request was sent.
        //
        // With a reconnect window, Mux holds the stream open after our RTMP
        // socket closes, so PUT /complete ends it immediately instead of waiting
        // the window out. With no reconnect window (the default) Mux finalizes
        // the asset the moment the client closes RTMP — which has already
        // happened by the time this action runs — so an explicit /complete would
        // only no-op against an already-idle stream. Skip the redundant call.
        const completeConfig = getMuxConfig()
        let completeSignaled = true
        if (completeConfig.reconnectWindowSeconds > 0) {
          try {
            await muxRequest(`/live-streams/${activeSession.muxLiveStreamId}/complete`, {
              method: 'PUT',
            })
          } catch (error) {
            completeSignaled = false
            console.warn('Failed to signal Mux live stream complete:', error)
          }
        }

        if (ingest.status === 'unknown') {
          // We could not confirm ingest with Mux inside the window (Mux
          // unreachable or ambiguous). Destroying the record here is exactly the
          // recording-loss bug we are guarding against, so instead we demote to
          // 'processing' and let the stuck-record reaper reconcile against Mux —
          // it recovers a real VOD if one appears, or errors the row out after
          // its give-up window if nothing ever does.
          await ctx.runMutation(internal.serverTelemetry.recordServerEvent, {
            level: 'warn',
            event: 'live:complete_unconfirmed',
            message: 'Could not confirm Mux ingest before timeout; demoting to processing',
            userId,
            data: {
              liveSessionId: args.liveSessionId,
              status: activeSession.status,
              source: ingest.source,
              completeSignaled,
              waitedMs,
              ageMs: Date.now() - activeSession.createdAt,
            },
          })
        } else if (waitedMs > 0) {
          // Confirmed, but only after waiting — telemetry to tune the window.
          await ctx.runMutation(internal.serverTelemetry.recordServerEvent, {
            level: 'info',
            event: 'live:ingest_confirmed_after_wait',
            message: `Mux ingest confirmed after ${waitedMs}ms via ${ingest.source}`,
            userId,
            data: {
              liveSessionId: args.liveSessionId,
              source: ingest.source,
              waitedMs,
              ageMs: Date.now() - activeSession.createdAt,
            },
          })
        }

        await ctx.runMutation(internal.videos.markMuxLiveSessionEnding, {
          userId,
          liveSessionId: args.liveSessionId,
          reason: args.reason,
        })

        // Set videoStatus to "processing" while waiting for VOD
        await ctx.runMutation(internal.videos.markLinkedRecordProcessing, {
          liveSessionId: args.liveSessionId,
        })

        // Poll for the recorded VOD in the background so the creator's stop tap
        // returns immediately. The Mux webhook is the durable fallback if polling
        // misses the asset.
        await ctx.scheduler.runAfter(0, internal.videos.pollRecordedVodAsset, {
          userId,
          liveSessionId: args.liveSessionId,
        })

        return { ended: true, completeSignaled, recordingStarted: true }
      },
    ),
})

/**
 * Background fast-path: poll Mux for the recorded VOD asset (up to 60s) after
 * a live stream ends, flipping the record from 'processing' to 'ready' sooner
 * than the webhook would. Safe to lose — the asset-ready webhook covers it.
 */
export const pollRecordedVodAsset = internalAction({
  args: {
    userId: v.id('users'),
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx, args) => {
    const maxPolls = 30
    const pollIntervalMs = 2000

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))

      const session = await ctx.runQuery(internal.videos.getMuxLiveSessionForUser, {
        userId: args.userId,
        liveSessionId: args.liveSessionId,
      })
      if (!session) {
        return
      }

      // Prefer the asset ID the asset.created webhook recorded. Fall back to
      // muxRecentAssetId (set by the live_stream.idle webhook) so a creator
      // who taps End before video.asset.created arrives still gets the VOD
      // promoted as soon as Mux finishes encoding.
      const polledAssetId = session.muxRecordedAssetId ?? session.muxRecentAssetId

      if (polledAssetId) {
        const asset = parseMuxData(await muxRequest(`/assets/${polledAssetId}`))
        const status = readOptionalString(asset.status)
        if (status === 'ready') {
          const info = readMuxAssetInfo(asset)
          if (!info.playbackId) {
            // Asset is ready but has no playback ID yet — let the webhook finish.
            console.warn('Recorded live asset ready without playback ID, deferring to webhook')
            return
          }
          await ctx.runMutation(internal.videos.markMuxAssetReady, {
            assetId: info.assetId,
            liveStreamId: session.muxLiveStreamId,
            playbackId: info.playbackId,
            assetStatus: info.assetStatus,
            durationMs: info.durationMs,
            muxAspectRatio: info.muxAspectRatio,
            muxMaxResolution: info.muxMaxResolution,
          })
          return
        }
        if (status === 'errored') {
          const muxErrorInfo = readMuxErrorInfo(asset)
          await ctx.runMutation(internal.videos.markMuxAssetErrored, {
            assetId: polledAssetId,
            liveStreamId: session.muxLiveStreamId,
            assetStatus: status,
            muxErrorMessage: muxErrorInfo.message,
          })
          return
        }
      }

      // No asset known yet. If Mux has already linked a recorded asset to the
      // stream, persist it on the session so we can start polling against it.
      // Cheaper than GETting the live stream on every iteration.
      if (!polledAssetId) {
        const liveStream = await muxRequestOptional(`/live-streams/${session.muxLiveStreamId}`)
        if (liveStream) {
          const liveData = parseMuxData(liveStream)
          const recentAssetIds = Array.isArray(liveData.recent_asset_ids)
            ? (liveData.recent_asset_ids as unknown[]).filter(
                (id): id is string => typeof id === 'string',
              )
            : []
          const discoveredAssetId =
            readOptionalString(liveData.active_asset_id) ??
            (recentAssetIds.length > 0 ? recentAssetIds[recentAssetIds.length - 1] : undefined)
          if (discoveredAssetId) {
            await ctx.runMutation(internal.videos.recordPolledLiveAssetId, {
              liveSessionId: session._id,
              assetId: discoveredAssetId,
            })
          }
        }
      }

      // If the linked record has already been promoted to 'ready' or
      // 'errored' (by a webhook arriving between polls), there is nothing
      // left to do.
      const linkedVideoStatus = await ctx.runQuery(internal.videos.getLinkedLiveRecordVideoStatus, {
        liveSessionId: session._id,
      })
      if (linkedVideoStatus === 'ready' || linkedVideoStatus === 'errored') {
        return
      }
    }
  },
})

// Persist a discovered recorded-asset ID on a live session so the VOD poller
// can keep tracking it after a fresh discovery. Distinct from the
// video.asset.created webhook path so poller-only writes don't fire side
// effects.
export const recordPolledLiveAssetId = internalMutation({
  args: {
    liveSessionId: v.id('liveSessions'),
    assetId: v.string(),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession) return { updated: false }
    if (liveSession.muxRecordedAssetId === args.assetId) {
      return { updated: false }
    }
    await ctx.db.patch(liveSession._id, {
      muxRecentAssetId: liveSession.muxRecentAssetId ?? args.assetId,
      muxRecordedAssetId: args.assetId,
      updatedAt: Date.now(),
    })
    return { updated: true }
  },
})

export const getLinkedLiveRecordVideoStatus = internalQuery({
  args: {
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession) return null
    const record = await getLinkedLiveRecord(ctx, liveSession)
    return record?.videoStatus ?? null
  },
})

// ── New mutation: mark linked record as processing after stream ends ──

export const markLinkedRecordProcessing = internalMutation({
  args: {
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession) {
      return { updated: false }
    }

    const patch = {
      videoStatus: 'processing' as const,
      muxAssetStatus: 'processing',
    }

    if (liveSession.bondfireVideoId) {
      await ctx.db.patch(liveSession.bondfireVideoId, patch)
    }

    if (liveSession.bondfireId) {
      await ctx.db.patch(liveSession.bondfireId, {
        ...patch,
        updatedAt: Date.now(),
      })
    }

    return { updated: true }
  },
})

export const cancelLiveStream = action({
  args: {
    liveSessionId: v.id('liveSessions'),
    reason: v.optional(v.string()),
  },
  handler: (ctx, args): Promise<{ cancelled: boolean }> =>
    withUserFacingActionErrors(
      ctx,
      'videos.cancelLiveStream',
      'Something went wrong cancelling your recording. Please try again.',
      async () => {
        const userId = await auth.getUserId(ctx)
        if (!userId) {
          throwUserError('Not authenticated')
        }

        const liveSession: Doc<'liveSessions'> | null = await ctx.runQuery(
          internal.videos.getMuxLiveSessionForUser,
          {
            userId,
            liveSessionId: args.liveSessionId,
          },
        )

        if (!liveSession) {
          throwUserError('Live session not found')
        }

        try {
          await deleteMuxLiveStream(liveSession.muxLiveStreamId)
        } catch (error) {
          console.warn('Failed to delete Mux live stream during cancellation:', error)
          throw new Error('Failed to cancel Mux live stream')
        }

        return await ctx.runMutation(internal.videos.cancelMuxLiveSessionRecord, {
          userId,
          liveSessionId: args.liveSessionId,
          reason: args.reason ?? 'cancelled',
        })
      },
    ),
})

async function markBondfireLiveFromPending(
  ctx: MutationCtx,
  bondfireId: Id<'bondfires'>,
  expectedUserId?: Id<'users'>,
) {
  const bondfire = await ctx.db.get(bondfireId)
  if (!bondfire) throwUserError('Bondfire not found')
  if (expectedUserId && bondfire.userId !== expectedUserId) {
    throwUserError('Not authorized')
  }
  if (bondfire.videoStatus !== 'pending') {
    return
  }

  const now = Date.now()
  await ctx.db.patch(bondfireId, {
    videoStatus: 'live',
    recordedAt: now,
    updatedAt: now,
  })

  if (bondfire.campId) {
    const user = await ctx.db.get(bondfire.userId)
    await ctx.scheduler.runAfter(0, internal.sendNotification.notifyCampBondfire, {
      bondfireId,
      creatorId: bondfire.userId,
      creatorName: user?.displayName ?? user?.name ?? 'Someone',
    })
  }
}

/**
 * Public mutation: flip pending to live when the user taps record after pre-connect.
 */
export const markBondfireLive = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) throwUserError('Not authenticated')
    await markBondfireLiveFromPending(ctx, args.bondfireId, userId)
  },
})

/**
 * Heartbeat for an in-flight live session so the stale-session cron doesn't
 * reap it while the creator is still previewing or actively recording.
 * Pending ('created') sessions are still hard-capped by
 * MAX_PENDING_LIVE_SESSION_AGE_MS regardless of heartbeats.
 */
export const touchLiveSession = mutation({
  args: {
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) throwUserError('Not authenticated')

    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession || liveSession.userId !== userId) {
      return { touched: false }
    }

    await ctx.db.patch(args.liveSessionId, { updatedAt: Date.now() })
    return { touched: true }
  },
})

export const disableStaleLiveStreams = internalAction({
  args: {},
  handler: async (ctx) => {
    const staleSessions: Doc<'liveSessions'>[] = await ctx.runQuery(
      internal.videos.listStaleMuxLiveSessions,
      {},
    )

    let disabled = 0
    let missing = 0
    let failed = 0

    for (const session of staleSessions) {
      let outcome: 'disabled' | 'missing'
      try {
        outcome = await disableMuxLiveStream(session.muxLiveStreamId)
      } catch (error) {
        // Transient Mux/network failure — leave the row for the next cron tick.
        // An already-deleted stream is a 404, handled as 'missing' below, not here.
        console.warn('Failed to disable stale Mux live stream:', session.muxLiveStreamId, error)
        failed += 1
        continue
      }

      // Both a successful disable and an already-gone stream (404) mean Mux is
      // settled, so reap the DB row either way. Skipping the reap on 404 is what
      // wedged sessions in prod: the stream was already deleted (e.g. via cancel)
      // so disable 404'd forever and the row never left the stale list.
      await ctx.runMutation(internal.videos.markStaleMuxLiveSessionEnded, {
        liveSessionId: session._id,
      })

      if (outcome === 'missing') {
        missing += 1
      } else {
        disabled += 1
      }
    }

    return { disabled, missing, failed }
  },
})

// Generate URLs for Mux playback.
const videoUrlRequestArgs = {
  muxPlaybackId: v.string(),
  muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
  bondfireId: v.optional(v.id('bondfires')),
  bondfireVideoId: v.optional(v.id('bondfireVideos')),
}

type VideoUrlRequest = {
  muxPlaybackId: string
  muxPlaybackPolicy?: 'public' | 'signed'
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
}

// Never throws: access-validation and signing failures fall back to a public
// URL (Mux serves it or 403s), so one bad video cannot reject a whole
// getVideoUrlsBatch call. captionTrackId (the asset's generated-subtitle
// track) adds a captionsUrl to the result; captions are cosmetic, so the
// fallback paths simply omit it.
async function resolvePlaybackUrls(ctx: ActionCtx, args: VideoUrlRequest, captionTrackId?: string) {
  let playbackPolicy = args.muxPlaybackPolicy ?? 'public'
  try {
    if (args.bondfireId || args.bondfireVideoId || playbackPolicy === 'signed') {
      const userId = (await auth.getUserId(ctx)) ?? undefined

      const access = await ctx.runQuery(internal.videos.validatePlaybackAccess, {
        userId,
        muxPlaybackId: args.muxPlaybackId,
        bondfireId: args.bondfireId,
        bondfireVideoId: args.bondfireVideoId,
      })
      playbackPolicy = access.playbackPolicy
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    // If access validation fails (camp deleted, user booted, expired),
    // fall back to a public URL. Mux will serve it or 403, but the
    // app won't crash with a Server Error.
    try {
      await ctx.runMutation(internal.clientLogs.createInternal, {
        level: 'warn',
        event: 'video:get_urls:access_validation_failed',
        message,
        data: {
          muxPlaybackId: args.muxPlaybackId,
          bondfireId: args.bondfireId,
          bondfireVideoId: args.bondfireVideoId,
          stack,
        },
        platform: 'server',
        createdAt: Date.now(),
      })
    } catch {
      // Best effort — don't fail the video URL request over logging
    }
    return {
      hdUrl: getMuxPlaybackUrl(args.muxPlaybackId),
      thumbnailUrl: getMuxThumbnailUrl(args.muxPlaybackId),
      expiresIn: 0,
    }
  }

  if (playbackPolicy === 'signed') {
    try {
      const token = await signMuxPlaybackToken(args.muxPlaybackId, 'v')
      const thumbnailToken = await signMuxPlaybackToken(args.muxPlaybackId, 't')

      return {
        hdUrl: withMuxToken(getMuxPlaybackUrl(args.muxPlaybackId), token),
        thumbnailUrl: withMuxToken(getMuxThumbnailUrl(args.muxPlaybackId), thumbnailToken),
        // Text tracks accept the same aud:'v' playback token as the stream.
        captionsUrl: captionTrackId
          ? withMuxToken(getMuxCaptionsUrl(args.muxPlaybackId, captionTrackId), token)
          : undefined,
        expiresIn: SIGNED_PLAYBACK_URL_TTL_SECONDS,
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const stack = e instanceof Error ? e.stack : undefined
      // Signed URL generation failed (missing signing key, bad key format,
      // etc.). Fall back to public URL so the video player isn't broken.
      try {
        await ctx.runMutation(internal.clientLogs.createInternal, {
          level: 'error',
          event: 'video:get_urls:signing_failed',
          message,
          data: {
            muxPlaybackId: args.muxPlaybackId,
            bondfireId: args.bondfireId,
            bondfireVideoId: args.bondfireVideoId,
            playbackPolicy,
            stack,
          },
          platform: 'server',
          createdAt: Date.now(),
        })
      } catch {
        // Best effort
      }
      return {
        hdUrl: getMuxPlaybackUrl(args.muxPlaybackId),
        thumbnailUrl: getMuxThumbnailUrl(args.muxPlaybackId),
        expiresIn: 0,
      }
    }
  }

  return {
    hdUrl: getMuxPlaybackUrl(args.muxPlaybackId),
    thumbnailUrl: getMuxThumbnailUrl(args.muxPlaybackId),
    captionsUrl: captionTrackId ? getMuxCaptionsUrl(args.muxPlaybackId, captionTrackId) : undefined,
    expiresIn: 0,
  }
}

async function lookupCaptionTrackIds(
  ctx: ActionCtx,
  items: VideoUrlRequest[],
): Promise<(string | null)[]> {
  try {
    return await ctx.runQuery(internal.ai.getCaptionTrackIds, {
      items: items.map((item) => ({
        muxPlaybackId: item.muxPlaybackId,
        bondfireId: item.bondfireId,
        bondfireVideoId: item.bondfireVideoId,
      })),
    })
  } catch {
    // Captions are cosmetic — never fail a playback URL request over them.
    return items.map(() => null)
  }
}

export const getVideoUrls = action({
  args: videoUrlRequestArgs,
  handler: async (ctx, args) => {
    const [captionTrackId] = await lookupCaptionTrackIds(ctx, [args])
    return resolvePlaybackUrls(ctx, args, captionTrackId ?? undefined)
  },
})

const MAX_VIDEO_URL_BATCH = 100

// One round trip for a whole bondfire's worth of playback URLs. The client
// used to issue one getVideoUrls call per video, so opening a bondfire waited
// on the slowest of N websocket round trips. Items resolve in parallel and
// fail independently (per-item public-URL fallback).
export const getVideoUrlsBatch = action({
  args: { items: v.array(v.object(videoUrlRequestArgs)) },
  handler: async (ctx, { items }) => {
    if (items.length > MAX_VIDEO_URL_BATCH) {
      throw new Error(`getVideoUrlsBatch supports at most ${MAX_VIDEO_URL_BATCH} items`)
    }
    const captionTrackIds = await lookupCaptionTrackIds(ctx, items)
    return Promise.all(
      items.map((item, index) =>
        resolvePlaybackUrls(ctx, item, captionTrackIds[index] ?? undefined),
      ),
    )
  },
})

export const getThumbnailUrl = action({
  args: {
    muxPlaybackId: v.string(),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
    bondfireId: v.optional(v.id('bondfires')),
    bondfireVideoId: v.optional(v.id('bondfireVideos')),
  },
  handler: async (ctx, args) => {
    let playbackPolicy = args.muxPlaybackPolicy ?? 'public'
    // Thumbnail URLs are cosmetic — don't throw on access validation failures.
    // If the bondfire/camp is gone or the user lost access, fall back to a
    // public Mux thumbnail URL (Mux may serve it or 403 — either is fine).
    try {
      if (args.bondfireId || args.bondfireVideoId || playbackPolicy === 'signed') {
        const userId = (await auth.getUserId(ctx)) ?? undefined

        const access = await ctx.runQuery(internal.videos.validatePlaybackAccess, {
          userId,
          muxPlaybackId: args.muxPlaybackId,
          bondfireId: args.bondfireId,
          bondfireVideoId: args.bondfireVideoId,
        })
        playbackPolicy = access.playbackPolicy
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Access validation failed — return a public thumbnail URL as a fallback.
      // The Mux CDN may serve it or return 403, but the feed won't crash.
      try {
        await ctx.runMutation(internal.clientLogs.createInternal, {
          level: 'warn',
          event: 'video:thumbnail:access_validation_failed',
          message,
          data: {
            muxPlaybackId: args.muxPlaybackId,
            bondfireId: args.bondfireId,
            bondfireVideoId: args.bondfireVideoId,
          },
          platform: 'server',
          createdAt: Date.now(),
        })
      } catch {
        // Best effort
      }
      return {
        thumbnailUrl: getMuxThumbnailUrl(args.muxPlaybackId),
        previewUrl: getMuxPreviewUrl(args.muxPlaybackId),
        expiresIn: 0,
      }
    }

    if (playbackPolicy === 'signed') {
      try {
        const thumbnailToken = await signMuxPlaybackToken(args.muxPlaybackId, 't')
        const previewToken = await signMuxPlaybackToken(args.muxPlaybackId, 'g')

        return {
          thumbnailUrl: withMuxToken(getMuxThumbnailUrl(args.muxPlaybackId), thumbnailToken),
          previewUrl: withMuxToken(getMuxPreviewUrl(args.muxPlaybackId), previewToken),
          expiresIn: SIGNED_PLAYBACK_URL_TTL_SECONDS,
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const stack = e instanceof Error ? e.stack : undefined
        try {
          await ctx.runMutation(internal.clientLogs.createInternal, {
            level: 'error',
            event: 'video:thumbnail:signing_failed',
            message,
            data: {
              muxPlaybackId: args.muxPlaybackId,
              bondfireId: args.bondfireId,
              bondfireVideoId: args.bondfireVideoId,
              playbackPolicy,
              stack,
            },
            platform: 'server',
            createdAt: Date.now(),
          })
        } catch {
          // Best effort
        }
        return {
          thumbnailUrl: getMuxThumbnailUrl(args.muxPlaybackId),
          previewUrl: getMuxPreviewUrl(args.muxPlaybackId),
          expiresIn: 0,
        }
      }
    }

    return {
      thumbnailUrl: getMuxThumbnailUrl(args.muxPlaybackId),
      previewUrl: getMuxPreviewUrl(args.muxPlaybackId),
      expiresIn: 0,
    }
  },
})

export const validateCreateCampContext = internalQuery({
  args: {
    userId: v.id('users'),
    campId: v.id('camps'),
    durationMs: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertCanCreateInCamp(ctx, args)
    return { valid: true }
  },
})

export const validateRespondCampContext = internalQuery({
  args: {
    userId: v.id('users'),
    bondfireId: v.id('bondfires'),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertCanRespondToBondfire(ctx, args)
    return { valid: true }
  },
})

// Public validation queries let the client fail fast before initiating an upload.
export const validateCreateCamp = query({
  args: {
    campId: v.id('camps'),
    durationMs: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return { valid: false, error: 'You must have an account to spark a Bondfire' }
    }
    try {
      await assertCanCreateInCamp(ctx, {
        userId,
        campId: args.campId,
        durationMs: args.durationMs,
        tags: args.tags,
      })
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Cannot spark in this camp',
      }
    }
  },
})

export const validateRespondCamp = query({
  args: {
    bondfireId: v.id('bondfires'),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return { valid: false, error: 'You must have an account to respond to a Bondfire' }
    }
    try {
      await assertCanRespondToBondfire(ctx, {
        userId,
        bondfireId: args.bondfireId,
        durationMs: args.durationMs,
      })
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Cannot respond to this Bondfire',
      }
    }
  },
})

export const validatePersonalCreate = query({
  args: {},
  handler: async (ctx, _args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return { valid: false, error: 'You must have an account to spark a Personal Bondfire' }
    }

    try {
      await assertCanCreatePersonalBondfire(ctx, { userId })
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'You cannot create a Personal Bondfire',
      }
    }
  },
})

export const validatePersonalCreateForUser = internalQuery({
  args: {
    userId: v.id('users'),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertCanCreatePersonalBondfire(ctx, args)
    return { valid: true }
  },
})

export const getMuxPlaybackPolicyForNewRecord = internalQuery({
  args: {
    userId: v.id('users'),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    durationMs: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{ playbackPolicy: PlaybackPolicy }> => {
    if (args.isResponse) {
      if (!args.bondfireId) {
        throwUserError('A bondfire ID is required when creating a response')
      }

      const bondfire = await assertCanRespondToBondfire(ctx, {
        userId: args.userId,
        bondfireId: args.bondfireId,
        durationMs: args.durationMs,
      })

      if (bondfire.muxPlaybackPolicy === 'signed') {
        return { playbackPolicy: 'signed' }
      }

      if (bondfire.personalCampId) {
        return { playbackPolicy: 'signed' }
      }

      if (bondfire.campId) {
        const camp = await ctx.db.get(bondfire.campId)
        if (camp?.access === 'invite') {
          return { playbackPolicy: 'signed' }
        }
      }

      return { playbackPolicy: getConfiguredPlaybackPolicy() }
    }

    if (!args.campId) {
      throwUserError('Choose a camp before sparking a Bondfire')
    }

    const camp = await assertCanCreateInCamp(ctx, {
      userId: args.userId,
      campId: args.campId,
      durationMs: args.durationMs,
      tags: args.tags,
    })

    return {
      playbackPolicy: camp.access === 'invite' ? 'signed' : getConfiguredPlaybackPolicy(),
    }
  },
})

export const validatePlaybackAccess = internalQuery({
  args: {
    userId: v.optional(v.id('users')),
    muxPlaybackId: v.string(),
    bondfireId: v.optional(v.id('bondfires')),
    bondfireVideoId: v.optional(v.id('bondfireVideos')),
  },
  handler: async (ctx, args): Promise<{ playbackPolicy: PlaybackPolicy }> => {
    if (args.bondfireId) {
      const bondfire = await ctx.db.get(args.bondfireId)
      if (
        !bondfire ||
        (bondfire.muxPlaybackId !== args.muxPlaybackId &&
          bondfire.muxLivePlaybackId !== args.muxPlaybackId)
      ) {
        throwUserError('Video not found')
      }

      if (bondfire.personalCampId && bondfire.muxPlaybackPolicy !== 'signed') {
        throw new Error('Personal fire video is missing signed Mux playback')
      }

      if (bondfire.campId) {
        const camp = await ctx.db.get(bondfire.campId)
        if (camp?.access === 'invite' && bondfire.muxPlaybackPolicy !== 'signed') {
          throw new Error('Private camp video is missing signed Mux playback')
        }
      }

      if (bondfire.muxPlaybackPolicy === 'signed') {
        if (!args.userId) {
          throwUserError('Not authenticated')
        }
        await assertCanViewBondfire(ctx, { userId: args.userId, bondfire })
      }

      return { playbackPolicy: bondfire.muxPlaybackPolicy ?? 'public' }
    }

    if (args.bondfireVideoId) {
      const video = await ctx.db.get(args.bondfireVideoId)
      if (
        !video ||
        (video.expiresAt !== undefined && video.expiresAt <= Date.now()) ||
        (video.muxPlaybackId !== args.muxPlaybackId &&
          video.muxLivePlaybackId !== args.muxPlaybackId)
      ) {
        throwUserError('Video not found')
      }

      const bondfire = await ctx.db.get(video.bondfireId)
      if (!bondfire) {
        throwUserError('Bondfire not found')
      }

      if (bondfire.personalCampId && video.muxPlaybackPolicy !== 'signed') {
        throw new Error('Personal fire response video is missing signed Mux playback')
      }

      if (bondfire.campId) {
        const camp = await ctx.db.get(bondfire.campId)
        if (camp?.access === 'invite' && video.muxPlaybackPolicy !== 'signed') {
          throw new Error('Private camp response video is missing signed Mux playback')
        }
      }

      if (video.muxPlaybackPolicy === 'signed') {
        if (!args.userId) {
          throwUserError('Not authenticated')
        }
        await assertCanViewBondfire(ctx, { userId: args.userId, bondfire })
      }

      return { playbackPolicy: video.muxPlaybackPolicy ?? 'public' }
    }

    throwUserError('A Bondfire or response ID is required for signed playback')
  },
})

export const createPendingMuxVideo = internalMutation({
  args: {
    userId: v.id('users'),
    uploadId: v.string(),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    personalCamp: v.optional(v.boolean()),
    tags: v.optional(v.array(v.string())),
    playbackPolicy: v.union(v.literal('public'), v.literal('signed')),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const user = await ctx.db.get(args.userId)

    if (args.isResponse) {
      if (!args.bondfireId) {
        throwUserError('A bondfire ID is required when creating a pending response upload')
      }

      const bondfire = await assertCanRespondToBondfire(ctx, {
        userId: args.userId,
        bondfireId: args.bondfireId,
        durationMs: args.durationMs,
      })
      if (bondfire.personalCampId && args.playbackPolicy !== 'signed') {
        throw new Error('Personal fire responses must use signed Mux playback')
      }

      const existingVideos = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId as Id<'bondfires'>))
        .collect()
      const sequenceNumber = existingVideos.length + 1
      const recordId = await ctx.db.insert('bondfireVideos', {
        bondfireId: args.bondfireId,
        userId: args.userId,
        creatorName: user?.displayName ?? user?.name,
        sequenceNumber,
        videoStatus: 'waiting_for_upload',
        muxUploadId: args.uploadId,
        muxPlaybackPolicy: args.playbackPolicy,
        muxAssetStatus: 'waiting_for_upload',
        durationMs: args.durationMs,
        width: args.width,
        height: args.height,
        tags: args.tags,
        expiresAt: bondfire.expiresAt,
        createdAt: now,
      })

      return { recordId, recordType: 'response' as const }
    }

    // Personal camp bondfire creation
    if (args.personalCamp) {
      if (args.playbackPolicy === 'public') {
        throw new Error('Personal fire videos must use signed playback.')
      }

      const personalCamp = await assertCanCreatePersonalBondfire(ctx, {
        userId: args.userId,
        durationMs: args.durationMs,
      })

      const recordId = await ctx.db.insert('bondfires', {
        userId: args.userId,
        creatorName: user?.displayName ?? user?.name,
        personalCampId: personalCamp._id,
        frozen: false,
        videoStatus: 'waiting_for_upload',
        muxUploadId: args.uploadId,
        muxPlaybackPolicy: args.playbackPolicy ?? 'signed',
        muxAssetStatus: 'waiting_for_upload',
        durationMs: args.durationMs,
        width: args.width,
        height: args.height,
        tags: args.tags,
        videoCount: 1,
        viewCount: 0,
        createdAt: now,
        updatedAt: now,
      })

      // Add the owner as a participant.
      await ctx.db.insert('personalBondfireParticipants', {
        bondfireId: recordId,
        userId: args.userId,
        status: 'active',
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      })

      // Update user's bondfire count.
      await ctx.db.patch(args.userId, {
        bondfireCount: (user?.bondfireCount ?? 0) + 1,
        updatedAt: now,
      })

      return { recordId, recordType: 'bondfire' as const }
    }

    if (!args.campId) {
      throwUserError('Choose a camp before sparking a Bondfire')
    }

    const camp = await assertCanCreateInCamp(ctx, {
      userId: args.userId,
      campId: args.campId,
      durationMs: args.durationMs,
      tags: args.tags,
    })
    const expiresAt = await getPrivateCampExpiresAt(ctx, camp, now)

    const recordId = await ctx.db.insert('bondfires', {
      userId: args.userId,
      creatorName: user?.displayName ?? user?.name,
      campId: args.campId,
      frozen: false,
      videoStatus: 'waiting_for_upload',
      muxUploadId: args.uploadId,
      muxPlaybackPolicy: args.playbackPolicy,
      muxAssetStatus: 'waiting_for_upload',
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
      expiresAt,
      videoCount: 1,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    return { recordId, recordType: 'bondfire' as const }
  },
})

export const deleteLegacyVideoOnDemandContent = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const [bondfires, responseVideos] = await Promise.all([
      ctx.db.query('bondfires').collect(),
      ctx.db.query('bondfireVideos').collect(),
    ])
    const legacyBondfires = bondfires.filter(
      (bondfire) => !bondfire.muxUploadId && !bondfire.muxAssetId && !bondfire.muxPlaybackId,
    )
    const legacyBondfireIds = new Set(legacyBondfires.map((bondfire) => bondfire._id))
    const legacyResponseVideos = responseVideos.filter(
      (video) =>
        !video.muxUploadId &&
        !video.muxAssetId &&
        !video.muxPlaybackId &&
        !legacyBondfireIds.has(video.bondfireId),
    )

    if (args.dryRun) {
      return {
        bondfiresToDelete: legacyBondfires.length,
        responseVideosToDelete: legacyResponseVideos.length,
      }
    }

    const affectedUsers = new Set<Id<'users'>>()
    const affectedBondfires = new Set<Id<'bondfires'>>()

    for (const video of legacyResponseVideos) {
      affectedUsers.add(video.userId)
      affectedBondfires.add(video.bondfireId)
      await ctx.db.delete(video._id)
    }

    for (const bondfire of legacyBondfires) {
      affectedUsers.add(bondfire.userId)

      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      for (const response of responses) {
        affectedUsers.add(response.userId)
        await ctx.db.delete(response._id)
      }

      await ctx.db.delete(bondfire._id)
    }

    for (const bondfireId of affectedBondfires) {
      const bondfire = await ctx.db.get(bondfireId)
      if (!bondfire) {
        continue
      }

      const readyResponses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect()

      await ctx.db.patch(bondfireId, {
        videoCount:
          1 +
          readyResponses.filter(
            (video) => (video.videoStatus ?? 'ready') === 'ready' && video.muxPlaybackId,
          ).length,
        updatedAt: Date.now(),
      })
    }

    for (const userId of affectedUsers) {
      const [userBondfires, userResponses] = await Promise.all([
        ctx.db
          .query('bondfires')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect(),
        ctx.db
          .query('bondfireVideos')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect(),
      ])

      await ctx.db.patch(userId, {
        bondfireCount: userBondfires.filter(
          (bondfire) => (bondfire.videoStatus ?? 'ready') === 'ready' && bondfire.muxPlaybackId,
        ).length,
        responseCount: userResponses.filter(
          (video) => (video.videoStatus ?? 'ready') === 'ready' && video.muxPlaybackId,
        ).length,
        updatedAt: Date.now(),
      })
    }

    return {
      deletedBondfires: legacyBondfires.length,
      deletedResponseVideos: legacyResponseVideos.length,
    }
  },
})

export const markMuxAssetCreated = internalMutation({
  args: {
    uploadId: v.string(),
    assetId: v.string(),
    assetStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const record = await findMuxRecord(ctx, args)
    if (!record) {
      return { updated: false }
    }

    await markRecordAssetCreated(ctx, record, args)
    return { updated: true }
  },
})

export const markMuxAssetReady = internalMutation({
  args: {
    uploadId: v.optional(v.string()),
    assetId: v.string(),
    liveStreamId: v.optional(v.string()),
    playbackId: v.string(),
    playbackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
    assetStatus: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    muxAspectRatio: v.optional(v.string()),
    muxMaxResolution: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const record = await findMuxRecord(ctx, args)
    if (!record) {
      return { updated: false }
    }

    const status = await markRecordReady(ctx, record, args)
    return { updated: true, rejected: status === 'rejected' }
  },
})

export const markMuxAssetErrored = internalMutation({
  args: {
    uploadId: v.optional(v.string()),
    assetId: v.optional(v.string()),
    liveStreamId: v.optional(v.string()),
    assetStatus: v.optional(v.string()),
    muxErrorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const record = await findMuxRecord(ctx, args)
    if (!record) {
      return { updated: false }
    }

    await markRecordErrored(ctx, record, args)
    return { updated: true }
  },
})

export const createLinkedMuxLiveSession = internalMutation({
  args: {
    userId: v.id('users'),
    liveStreamId: v.string(),
    playbackId: v.optional(v.string()),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    personalCamp: v.optional(v.boolean()),
    playbackPolicy: v.union(v.literal('public'), v.literal('signed')),
    latencyMode: v.union(v.literal('standard'), v.literal('reduced'), v.literal('low')),
    tags: v.optional(v.array(v.string())),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    title: v.optional(v.string()),
    pending: v.optional(v.boolean()), // If true, create bondfire in 'pending' status
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const user = await ctx.db.get(args.userId)
    let expiresAt: number | undefined

    if (args.isResponse) {
      if (!args.bondfireId) {
        throwUserError('A bondfire ID is required when creating a live response')
      }

      const bondfire = await assertCanRespondToBondfire(ctx, {
        userId: args.userId,
        bondfireId: args.bondfireId,
      })
      if (bondfire.personalCampId && args.playbackPolicy !== 'signed') {
        throw new Error('Personal fire responses must use signed Mux playback')
      }
      expiresAt = bondfire.expiresAt
    } else if (args.personalCamp) {
      if (args.playbackPolicy !== 'signed') {
        throw new Error('Personal fire live streams must use signed Mux playback')
      }
    } else {
      if (!args.campId) {
        throwUserError('Choose a camp before sparking a Bondfire')
      }

      const camp = await assertCanCreateInCamp(ctx, {
        userId: args.userId,
        campId: args.campId,
        tags: args.tags,
      })
      expiresAt = await getPrivateCampExpiresAt(ctx, camp, now)
    }

    const liveSessionId = await ctx.db.insert('liveSessions', {
      userId: args.userId,
      muxLiveStreamId: args.liveStreamId,
      muxLivePlaybackId: args.playbackId,
      transport: 'rtmps',
      latencyMode: args.latencyMode,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    })

    if (args.isResponse) {
      if (!args.bondfireId) {
        throwUserError('A bondfire ID is required when creating a live response')
      }

      const bondfire = await ctx.db.get(args.bondfireId)
      if (!bondfire) {
        throwUserError('Bondfire not found')
      }

      const existingVideos = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId as Id<'bondfires'>))
        .collect()
      const sequenceNumber = existingVideos.length + 1
      const recordId = await ctx.db.insert('bondfireVideos', {
        bondfireId: args.bondfireId,
        userId: args.userId,
        creatorName: user?.displayName ?? user?.name,
        sequenceNumber,
        liveSessionId,
        videoStatus: 'live',
        muxLiveStreamId: args.liveStreamId,
        muxLivePlaybackId: args.playbackId,
        muxPlaybackPolicy: args.playbackPolicy,
        muxAssetStatus: 'live',
        width: args.width,
        height: args.height,
        tags: args.tags,
        expiresAt,
        createdAt: now,
      })

      // The response is NOT counted into bondfire.videoCount here. Counting
      // happens at the live_stream.active webhook (when the stream is
      // actually watchable) via countResponse — same moment the response
      // notification fires. A stream that never goes active never shows up
      // in the response count.
      //
      // Response notification is sent by the Mux webhook at
      // live_stream.active (when the stream is actually watchable), not at
      // provisioning time — see handleMuxWebhook.
      await ctx.db.patch(liveSessionId, {
        bondfireVideoId: recordId,
        updatedAt: now,
      })

      return { liveSessionId, recordId, recordType: 'response' as const }
    }

    if (args.personalCamp) {
      const personalCamp = await assertCanCreatePersonalBondfire(ctx, { userId: args.userId })
      const initialStatus = args.pending ? 'pending' : 'live'
      const recordId = await ctx.db.insert('bondfires', {
        userId: args.userId,
        creatorName: user?.displayName ?? user?.name,
        personalCampId: personalCamp._id,
        title: args.title,
        frozen: false,
        liveSessionId,
        videoStatus: initialStatus,
        muxLiveStreamId: args.liveStreamId,
        muxLivePlaybackId: args.playbackId,
        muxPlaybackPolicy: args.playbackPolicy,
        muxAssetStatus: initialStatus,
        width: args.width,
        height: args.height,
        tags: args.tags,
        videoCount: 1,
        viewCount: 0,
        createdAt: now,
        updatedAt: now,
      })

      await ctx.db.insert('personalBondfireParticipants', {
        bondfireId: recordId,
        userId: args.userId,
        status: 'active',
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      })

      if (user) {
        await ctx.db.patch(args.userId, {
          bondfireCount: (user.bondfireCount ?? 0) + 1,
          updatedAt: now,
        })
      }

      await ctx.db.patch(liveSessionId, {
        bondfireId: recordId,
        updatedAt: now,
      })

      return { liveSessionId, recordId, recordType: 'bondfire' as const }
    }

    const initialStatus = args.pending ? 'pending' : 'live'
    const recordId = await ctx.db.insert('bondfires', {
      userId: args.userId,
      creatorName: user?.displayName ?? user?.name,
      campId: args.campId,
      title: args.title,
      frozen: false,
      liveSessionId,
      videoStatus: initialStatus,
      muxLiveStreamId: args.liveStreamId,
      muxLivePlaybackId: args.playbackId,
      muxPlaybackPolicy: args.playbackPolicy,
      muxAssetStatus: initialStatus,
      width: args.width,
      height: args.height,
      tags: args.tags,
      expiresAt,
      videoCount: 1,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    await ctx.db.patch(liveSessionId, {
      bondfireId: recordId,
      updatedAt: now,
    })

    return { liveSessionId, recordId, recordType: 'bondfire' as const }
  },
})

export const getMuxLiveSessionForUser = internalQuery({
  args: {
    userId: v.id('users'),
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession || liveSession.userId !== args.userId) {
      return null
    }

    return liveSession
  },
})

export const getActiveMuxLiveSessionForUser = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, args): Promise<Doc<'liveSessions'> | null> => {
    const sessions = await ctx.db
      .query('liveSessions')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(10)

    // 'ending' is intentionally excluded: that session was already cleanly
    // stopped (we signaled Mux /complete) and is just finalizing its VOD. It no
    // longer ingests, so it must not block the creator from starting their next
    // recording. A genuinely stuck 'ending' session is swept by the stale cron.
    const activeStatuses = new Set(['created', 'starting', 'live'])
    return sessions.find((session) => activeStatuses.has(session.status)) ?? null
  },
})

/**
 * Tier-aware cap (in seconds) passed to Mux as `max_continuous_duration` so
 * a stream the client never stops gets terminated by Mux itself instead of
 * running to Mux's 12-hour default.
 */
export const getLiveMaxContinuousDurationSeconds = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, args): Promise<number> => {
    const tier = await getEntitlementSubscriptionTier(ctx, args.userId)
    const maxDurationMs = getTierMaxVideoDurationMs(tier) ?? PRO_MAX_VIDEO_DURATION_MS
    const withBuffer = Math.ceil(maxDurationMs / 1000) + MUX_LIVE_MAX_DURATION_BUFFER_SECONDS
    return Math.min(
      MUX_LIVE_MAX_CONTINUOUS_DURATION_MAX_SECONDS,
      Math.max(MUX_LIVE_MAX_CONTINUOUS_DURATION_MIN_SECONDS, withBuffer),
    )
  },
})

export const listStaleMuxLiveSessions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const staleBefore = now - 5 * 60 * 1000
    const pendingMaxAgeBefore = now - MAX_PENDING_LIVE_SESSION_AGE_MS
    // 'created' covers sessions where the client errored before going live —
    // those would otherwise stay parked on Mux billing forever.
    const statuses = ['created', 'starting', 'live', 'ending'] as const
    const batches = await Promise.all(
      statuses.map((status) =>
        ctx.db
          .query('liveSessions')
          .withIndex('by_status', (q) => q.eq('status', status))
          .order('asc')
          .take(50),
      ),
    )

    return batches.flat().filter(
      (session) =>
        session.updatedAt < staleBefore ||
        // Hard cap on pending sessions: even an actively heartbeating preview
        // can't hold a provisioned stream open past the max pending age.
        (session.status === 'created' && session.createdAt < pendingMaxAgeBefore),
    )
  },
})

export const markMuxLiveSessionEnding = internalMutation({
  args: {
    userId: v.id('users'),
    liveSessionId: v.id('liveSessions'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession || liveSession.userId !== args.userId) {
      throwUserError('Live session not found')
    }

    const now = Date.now()
    await ctx.db.patch(args.liveSessionId, {
      status: 'ending',
      errorMessage: args.reason,
      updatedAt: now,
    })

    return { ended: true }
  },
})

export const cancelMuxLiveSessionRecord = internalMutation({
  args: {
    userId: v.id('users'),
    liveSessionId: v.id('liveSessions'),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession || liveSession.userId !== args.userId) {
      throwUserError('Live session not found')
    }

    if (liveSession.bondfireVideoId) {
      const video = await ctx.db.get(liveSession.bondfireVideoId)
      if (video) {
        // No-op for rows already uncounted by markRecordErrored /
        // markLinkedLiveRecordErrored, so a cancel retry after the
        // stale-session reaper can't double-decrement.
        await uncountResponse(ctx, video)
      }

      await ctx.db.delete(liveSession.bondfireVideoId)
    }
    if (liveSession.bondfireId && !liveSession.bondfireVideoId) {
      // Tolerate retried cancels — the row may already be gone.
      const bondfire = await ctx.db.get(liveSession.bondfireId)
      if (bondfire) {
        await ctx.db.delete(liveSession.bondfireId)
      }
    }

    // A cancel discards the session (and any linked record). If the session had
    // already made progress — gone live, started ingesting, or produced a Mux
    // asset — this likely destroyed a real recording. crash_recovery cancels of
    // a progressed session are exactly the recording-loss class of bug, so we
    // surface them as errors in triage; benign cancels of never-started sessions
    // are just breadcrumbs.
    const hadAsset = Boolean(
      liveSession.muxRecordedAssetId ??
        liveSession.muxActiveAssetId ??
        liveSession.muxRecentAssetId,
    )
    const hadProgressed =
      liveSession.status === 'live' ||
      liveSession.status === 'ending' ||
      Boolean(liveSession.startedAt) ||
      hadAsset
    await logServerEvent(ctx, {
      level: hadProgressed ? 'error' : 'breadcrumb',
      event: 'live:session:cancelled',
      message: hadProgressed
        ? `Cancelled a progressed live session (reason: ${args.reason})`
        : `Cancelled live session (reason: ${args.reason})`,
      userId: args.userId,
      retention: hadProgressed ? 'forensic' : 'standard',
      data: {
        liveSessionId: args.liveSessionId,
        reason: args.reason,
        statusBefore: liveSession.status,
        hadStarted: Boolean(liveSession.startedAt),
        hadAsset,
        hadLinkedRecord: Boolean(liveSession.bondfireId ?? liveSession.bondfireVideoId),
        ageMs: Date.now() - liveSession.createdAt,
      },
    })

    await ctx.db.patch(args.liveSessionId, {
      status: 'ended',
      endedAt: Date.now(),
      errorMessage: args.reason,
      updatedAt: Date.now(),
    })

    return { cancelled: true }
  },
})

export const markStaleMuxLiveSessionEnded = internalMutation({
  args: {
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession) {
      return { updated: false }
    }

    const now = Date.now()
    // Reaping a session the cron deemed stale. An 'ending' session reclaimed
    // here means Mux never finalized its VOD in time (the recording-loss
    // fallback path), which is worth surfacing for triage.
    await logServerEvent(ctx, {
      level:
        liveSession.status === 'ending' || liveSession.status === 'live' ? 'warn' : 'breadcrumb',
      event: 'live:session:reaped_stale',
      message: `Stale live session reaped (status: ${liveSession.status})`,
      userId: liveSession.userId,
      data: {
        liveSessionId: args.liveSessionId,
        statusBefore: liveSession.status,
        hadStarted: Boolean(liveSession.startedAt),
        hadAsset: Boolean(
          liveSession.muxRecordedAssetId ??
            liveSession.muxActiveAssetId ??
            liveSession.muxRecentAssetId,
        ),
        ageMs: now - liveSession.createdAt,
      },
    })
    await ctx.db.patch(args.liveSessionId, {
      status: 'ended',
      endedAt: liveSession.endedAt ?? now,
      errorMessage: liveSession.errorMessage ?? 'stale live session disabled',
      updatedAt: now,
    })
    await markLinkedLiveRecordErrored(ctx, liveSession)

    return { updated: true }
  },
})

export const handleMuxWebhookEvent = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    dataJson: v.string(),
    objectJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query('muxWebhookEvents')
      .withIndex('by_event_id', (q) => q.eq('eventId', args.eventId))
      .first()

    if (existingEvent) {
      return { ignored: true }
    }

    await ctx.db.insert('muxWebhookEvents', {
      eventId: args.eventId,
      eventType: args.eventType,
      createdAt: Date.now(),
    })

    const data = readObject(JSON.parse(args.dataJson), 'Mux webhook data')

    if (args.eventType === 'video.asset.track.ready') {
      // `data` is the track object here, so `data.id` is the TRACK id — the
      // generic asset-id extraction below must not run for this event. The
      // parent asset id arrives as data.asset_id or the event's object.id.
      const eventObject = args.objectJson
        ? readObject(JSON.parse(args.objectJson), 'Mux webhook object')
        : {}
      const trackAssetId = readOptionalString(data.asset_id) ?? readOptionalString(eventObject.id)
      const trackId = readOptionalString(data.id)
      const textSource = readOptionalString(data.text_source)
      if (readOptionalString(data.type) !== 'text' || !textSource?.startsWith('generated')) {
        // Only auto-generated caption tracks feed the AI pipeline.
        return { handled: false }
      }

      const record = trackAssetId ? await findMuxRecord(ctx, { assetId: trackAssetId }) : null
      if (!record || !trackAssetId || !trackId) {
        await logServerEvent(ctx, {
          level: 'warn',
          event: 'video:webhook:unmatched',
          message: 'Mux asset.track.ready webhook matched no bondfire record',
          data: { eventType: args.eventType, assetId: trackAssetId, trackId },
        })
        return { handled: false }
      }

      await ctx.scheduler.runAfter(0, internal.ai.processVideoTranscript, {
        table: record.table,
        recordId: record.document._id,
        muxAssetId: trackAssetId,
        muxTrackId: trackId,
        languageCode: readOptionalString(data.language_code),
      })
      return { handled: true }
    }

    // `data.id` is only an upload ID for video.upload.* events. For
    // video.asset.* events it is the asset ID and must not be used as one.
    const uploadId =
      readOptionalString(data.upload_id) ??
      (args.eventType.startsWith('video.upload.') ? readOptionalString(data.id) : undefined)
    const assetId =
      readOptionalString(data.asset_id) ??
      (args.eventType.startsWith('video.asset.') ? readOptionalString(data.id) : undefined)
    const assetStatus = readOptionalString(data.status)
    const liveStreamId = readOptionalString(data.live_stream_id)
    const webhookIds = { eventType: args.eventType, uploadId, assetId, liveStreamId }

    if (args.eventType === 'video.upload.asset_created' && uploadId && assetId) {
      const record = await findMuxRecord(ctx, { uploadId, assetId })
      if (record) {
        await markRecordAssetCreated(ctx, record, { assetId, assetStatus })
      } else {
        await logServerEvent(ctx, {
          level: 'warn',
          event: 'video:webhook:unmatched',
          message: 'Mux upload.asset_created webhook matched no bondfire record',
          data: webhookIds,
        })
      }
      return { handled: true }
    }

    if (args.eventType === 'video.asset.created' && assetId && liveStreamId) {
      // A live stream's recording asset was created. Remember it on the
      // session so pollRecordedVodAsset can promote the record to 'ready'
      // without waiting for the asset.ready webhook.
      const liveSession = await ctx.db
        .query('liveSessions')
        .withIndex('by_mux_live_stream', (q) => q.eq('muxLiveStreamId', liveStreamId))
        .first()
      if (liveSession) {
        await ctx.db.patch(liveSession._id, {
          muxRecordedAssetId: liveSession.muxRecordedAssetId ?? assetId,
          muxRecentAssetId: assetId,
          updatedAt: Date.now(),
        })
      }
      return { handled: true }
    }

    if (args.eventType === 'video.asset.ready' && assetId) {
      const playbackId = getMuxPlaybackId(data)
      const record = await findMuxRecord(ctx, { uploadId, assetId, liveStreamId })
      if (record && playbackId) {
        await markRecordReady(ctx, record, {
          assetId,
          playbackId,
          assetStatus: assetStatus ?? 'ready',
          durationMs: parseMuxDurationMs(data.duration),
          muxAspectRatio: readOptionalString(data.aspect_ratio),
          muxMaxResolution: readOptionalString(data.max_stored_resolution),
        })
      } else {
        // Dropping this event would leave the record stuck in 'processing'
        // until the reconciliation cron catches it — log loudly.
        await logServerEvent(ctx, {
          level: 'warn',
          event: record ? 'video:webhook:missing_playback_id' : 'video:webhook:unmatched',
          message: record
            ? 'Mux asset.ready webhook arrived without a playback ID'
            : 'Mux asset.ready webhook matched no bondfire record',
          data: webhookIds,
        })
      }

      if (liveStreamId) {
        const liveSession = await ctx.db
          .query('liveSessions')
          .withIndex('by_mux_live_stream', (q) => q.eq('muxLiveStreamId', liveStreamId))
          .first()
        if (liveSession) {
          await ctx.db.patch(liveSession._id, {
            muxRecordedAssetId: assetId,
            muxRecentAssetId: assetId,
            updatedAt: Date.now(),
          })
        }
      }
      return { handled: true }
    }

    if (
      ['video.asset.errored', 'video.upload.cancelled', 'video.upload.timed_out'].includes(
        args.eventType,
      )
    ) {
      const record = await findMuxRecord(ctx, { uploadId, assetId, liveStreamId })
      const muxErrorInfo = readMuxErrorInfo(data)
      const logData: Record<string, unknown> = {
        ...webhookIds,
        table: record?.table,
        recordId: record?.document._id,
      }
      if (muxErrorInfo.message) logData.muxErrorMessage = muxErrorInfo.message
      if (muxErrorInfo.details) logData.muxErrorDetails = muxErrorInfo.details
      if (record) {
        await markRecordErrored(ctx, record, {
          assetId,
          assetStatus,
          muxErrorMessage: muxErrorInfo.message,
        })
        await logServerEvent(ctx, {
          level: 'warn',
          event: 'video:webhook:asset_errored',
          message: `Mux reported ${args.eventType} for a bondfire record${muxErrorInfo.message ? `: ${muxErrorInfo.message}` : ''}`,
          data: logData,
          userId: record.document.userId,
        })
      } else {
        await logServerEvent(ctx, {
          level: 'warn',
          event: 'video:webhook:unmatched',
          message: `Mux ${args.eventType} webhook matched no bondfire record${muxErrorInfo.message ? `: ${muxErrorInfo.message}` : ''}`,
          data: logData,
        })
      }
      return { handled: true }
    }

    if (args.eventType.startsWith('video.live_stream.')) {
      // For live_stream.* events, the live stream id is the top-level `id`,
      // not the `live_stream_id` shadowed at the top of this handler.
      const eventLiveStreamId = readOptionalString(data.id)
      if (!eventLiveStreamId) {
        return { handled: false }
      }

      const liveSession = await ctx.db
        .query('liveSessions')
        .withIndex('by_mux_live_stream', (q) => q.eq('muxLiveStreamId', eventLiveStreamId))
        .first()

      if (!liveSession) {
        const stateChangingEvents = [
          'video.live_stream.active',
          'video.live_stream.idle',
          'video.live_stream.errored',
        ]
        if (stateChangingEvents.includes(args.eventType)) {
          await logServerEvent(ctx, {
            level: 'warn',
            event: 'video:webhook:unmatched',
            message: `Mux ${args.eventType} webhook matched no live session`,
            data: { eventType: args.eventType, liveStreamId: eventLiveStreamId },
          })
        }
        return { handled: false }
      }

      const now = Date.now()
      if (args.eventType === 'video.live_stream.connected') {
        await ctx.db.patch(liveSession._id, {
          status: 'starting',
          updatedAt: now,
        })
      } else if (args.eventType === 'video.live_stream.active') {
        await ctx.db.patch(liveSession._id, {
          status: 'live',
          startedAt: liveSession.startedAt ?? now,
          muxActiveAssetId:
            readOptionalString(data.active_asset_id) ?? liveSession.muxActiveAssetId,
          updatedAt: now,
        })
        // A late or retried 'active' delivery can arrive after asset.ready
        // already resolved the recording — don't clobber a finished record
        // back to 'live'.
        const linkedRecord = await getLinkedLiveRecord(ctx, liveSession)
        if (linkedRecord && !hasResolvedRecordedAsset(linkedRecord)) {
          await patchLinkedLiveRecord(ctx, liveSession, {
            videoStatus: 'live',
            muxAssetStatus: 'live',
          })
        }
        // Notify at the moment the stream is actually watchable. The
        // !startedAt guard keeps retried 'active' deliveries from
        // re-notifying; claimDeliveries dedupes against publish-time sends.
        if (!liveSession.startedAt) {
          const user = await ctx.db.get(liveSession.userId)
          const creatorName = user?.displayName ?? user?.name ?? 'Someone'

          if (liveSession.bondfireVideoId) {
            // Live response recording: the stream is watchable now, so this
            // is also the moment the response counts toward the thread.
            const responseVideo = await ctx.db.get(liveSession.bondfireVideoId)
            if (responseVideo) {
              await countResponse(ctx, responseVideo)
              await ctx.scheduler.runAfter(0, internal.sendNotification.notifyBondfireResponse, {
                bondfireId: responseVideo.bondfireId,
                responderId: liveSession.userId,
                responderName: creatorName,
                bondfireVideoId: liveSession.bondfireVideoId,
                isLive: true,
              })
            }
          } else if (liveSession.bondfireId) {
            // New live bondfire (camp or Hearth)
            await ctx.scheduler.runAfter(0, internal.sendNotification.notifyBondfireLive, {
              bondfireId: liveSession.bondfireId,
              creatorId: liveSession.userId,
              creatorName,
            })
          }
        }
      } else if (args.eventType === 'video.live_stream.disconnected') {
        await ctx.db.patch(liveSession._id, {
          status: 'ending',
          updatedAt: now,
        })
      } else if (args.eventType === 'video.live_stream.idle') {
        await ctx.db.patch(liveSession._id, {
          status: 'ended',
          endedAt: now,
          muxRecentAssetId:
            readOptionalString(data.recent_asset_id) ?? liveSession.muxRecentAssetId,
          updatedAt: now,
        })
        await markLinkedLiveRecordProcessing(ctx, liveSession)
      } else if (args.eventType === 'video.live_stream.errored') {
        await ctx.db.patch(liveSession._id, {
          status: 'errored',
          errorMessage: readOptionalString(data.error_message),
          updatedAt: now,
        })
        await markLinkedLiveRecordErrored(ctx, liveSession)
      }

      return { handled: true }
    }

    return { handled: false }
  },
})

// ── Stuck video reconciliation ──────────────────────────────────────────────
//
// The Mux webhook is the primary driver of videoStatus transitions, but a
// missed/unmatched event leaves records stuck in 'processing' or
// 'waiting_for_upload' forever (the dedup table ignores Mux retries once an
// event ID has been recorded). This cron re-queries Mux — the source of
// truth — for any record stuck in a non-terminal status and resolves it.

export const listStuckMuxRecords = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<StuckMuxRecord[]> => {
    const now = Date.now()
    const limit = args.limit ?? RECONCILE_BATCH_LIMIT
    const thresholds = {
      processing: STUCK_PROCESSING_THRESHOLD_MS,
      waiting_for_upload: STUCK_WAITING_FOR_UPLOAD_THRESHOLD_MS,
    } as const

    const results: StuckMuxRecord[] = []

    for (const status of ['processing', 'waiting_for_upload'] as const) {
      const cutoff = now - thresholds[status]

      const bondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_video_status', (q) => q.eq('videoStatus', status).lte('updatedAt', cutoff))
        .take(limit)
      for (const bondfire of bondfires) {
        results.push({
          table: 'bondfires',
          recordId: bondfire._id,
          userId: bondfire.userId,
          videoStatus: status,
          stuckForMs: now - bondfire.updatedAt,
          muxUploadId: bondfire.muxUploadId,
          muxAssetId: bondfire.muxAssetId,
          muxLiveStreamId: bondfire.muxLiveStreamId,
        })
      }

      // bondfireVideos has no updatedAt, so createdAt is the stuck clock.
      // It can only over-trigger (checking Mux early is harmless and idempotent).
      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_video_status', (q) => q.eq('videoStatus', status).lte('createdAt', cutoff))
        .take(limit)
      for (const video of responses) {
        results.push({
          table: 'bondfireVideos',
          recordId: video._id,
          userId: video.userId,
          videoStatus: status,
          stuckForMs: now - video.createdAt,
          muxUploadId: video.muxUploadId,
          muxAssetId: video.muxAssetId,
          muxLiveStreamId: video.muxLiveStreamId,
        })
      }
    }

    return results.slice(0, limit)
  },
})

async function reconcileStuckMuxRecord(
  ctx: ActionCtx,
  record: StuckMuxRecord,
): Promise<{ outcome: ReconcileOutcome; detail?: string }> {
  const recordRef = {
    uploadId: record.muxUploadId,
    liveStreamId: record.muxLiveStreamId,
  }

  // 1. Resolve the asset ID, asking Mux when our record doesn't have one yet.
  let assetId = record.muxAssetId

  if (!assetId && record.muxUploadId) {
    const upload = await muxRequestOptional(`/uploads/${record.muxUploadId}`)
    if (upload) {
      const uploadData = parseMuxData(upload)
      const uploadStatus = readOptionalString(uploadData.status) ?? 'waiting'
      assetId = readOptionalString(uploadData.asset_id)
      if (!assetId && MUX_FAILED_STATUSES.has(uploadStatus)) {
        await ctx.runMutation(internal.videos.markMuxAssetErrored, {
          uploadId: record.muxUploadId,
          assetStatus: uploadStatus,
        })
        return { outcome: 'errored', detail: `upload ${uploadStatus}` }
      }
    }
  }

  if (!assetId && record.muxLiveStreamId) {
    const liveStream = await muxRequestOptional(`/live-streams/${record.muxLiveStreamId}`)
    if (liveStream) {
      const liveData = parseMuxData(liveStream)
      const recentAssetIds = Array.isArray(liveData.recent_asset_ids)
        ? liveData.recent_asset_ids.filter((id): id is string => typeof id === 'string')
        : []
      assetId =
        readOptionalString(liveData.active_asset_id) ??
        (recentAssetIds.length > 0 ? recentAssetIds[recentAssetIds.length - 1] : undefined)
    }

    if (!assetId && record.videoStatus === 'processing') {
      if (record.stuckForMs > STUCK_LIVE_RECORDING_GIVE_UP_MS) {
        await ctx.runMutation(internal.videos.markMuxAssetErrored, {
          liveStreamId: record.muxLiveStreamId,
          assetStatus: 'recording_never_appeared',
        })
        return { outcome: 'errored', detail: 'live recording never appeared on Mux' }
      }
      return { outcome: 'still_processing', detail: 'awaiting live recording asset' }
    }
  }

  if (!assetId) {
    if (record.videoStatus === 'waiting_for_upload') {
      // Upload window may still be open — Mux reports timed_out when it closes,
      // which terminates the record on a later pass. But if the Mux upload
      // object is already gone (404) or never resolves, the record would sit in
      // waiting_for_upload forever: a permanent, unreachable orphan and a prime
      // source of "isn't available" dead ends. After a hard give-up window,
      // terminate it so it routes through markRecordErrored → the failure
      // handler (forensics + gated cleanup) instead of trapping viewers.
      if (record.stuckForMs > STUCK_WAITING_FOR_UPLOAD_GIVE_UP_MS) {
        if (record.muxUploadId || record.muxLiveStreamId) {
          await ctx.runMutation(internal.videos.markMuxAssetErrored, {
            uploadId: record.muxUploadId,
            liveStreamId: record.muxLiveStreamId,
            assetStatus: 'upload_never_received',
          })
          return { outcome: 'errored', detail: 'upload never received (gave up)' }
        }
        return { outcome: 'unresolved', detail: 'waiting_for_upload with no Mux identifiers' }
      }
      return { outcome: 'still_processing', detail: 'upload not received yet' }
    }
    // 'processing' with no Mux identifiers at all can never self-resolve.
    return { outcome: 'unresolved', detail: 'no Mux identifiers on record' }
  }

  // 2. The asset is the source of truth — sync our record to it.
  const asset = await muxRequestOptional(`/assets/${assetId}`)
  if (!asset) {
    await ctx.runMutation(internal.videos.markMuxAssetErrored, {
      ...recordRef,
      assetId,
      assetStatus: 'deleted',
    })
    return { outcome: 'errored', detail: 'asset deleted on Mux' }
  }

  const assetData = parseMuxData(asset)
  const info = readMuxAssetInfo(assetData)

  if (info.assetStatus && MUX_READY_STATUSES.has(info.assetStatus) && info.playbackId) {
    const result: { updated: boolean; rejected?: boolean } = await ctx.runMutation(
      internal.videos.markMuxAssetReady,
      {
        ...recordRef,
        assetId: info.assetId,
        playbackId: info.playbackId,
        assetStatus: info.assetStatus,
        durationMs: info.durationMs,
        muxAspectRatio: info.muxAspectRatio,
        muxMaxResolution: info.muxMaxResolution,
      },
    )
    if (!result.updated) {
      return { outcome: 'unresolved', detail: 'asset ready but record lookup failed' }
    }
    return result.rejected
      ? { outcome: 'errored', detail: 'duration limit exceeded' }
      : { outcome: 'recovered' }
  }

  if (info.assetStatus && MUX_FAILED_STATUSES.has(info.assetStatus)) {
    const muxErrorInfo = readMuxErrorInfo(assetData)
    await ctx.runMutation(internal.videos.markMuxAssetErrored, {
      ...recordRef,
      assetId,
      assetStatus: info.assetStatus,
      muxErrorMessage: muxErrorInfo.message,
    })
    return { outcome: 'errored', detail: `asset ${info.assetStatus}` }
  }

  return { outcome: 'still_processing', detail: `asset ${info.assetStatus ?? 'unknown'}` }
}

export const reconcileStuckMuxVideos = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    checked: number
    recovered: number
    errored: number
    stillProcessing: number
    unresolved: number
    failed: number
  }> => {
    const stuck: StuckMuxRecord[] = await ctx.runQuery(internal.videos.listStuckMuxRecords, {
      limit: args.limit,
    })

    const summary = {
      checked: stuck.length,
      recovered: 0,
      errored: 0,
      stillProcessing: 0,
      unresolved: 0,
      failed: 0,
    }

    if (args.dryRun || stuck.length === 0) {
      return summary
    }

    for (const record of stuck) {
      let outcome: ReconcileOutcome | 'failed'
      let detail: string | undefined

      try {
        const result = await reconcileStuckMuxRecord(ctx, record)
        outcome = result.outcome
        detail = result.detail
      } catch (error) {
        outcome = 'failed'
        detail = error instanceof Error ? error.message : String(error)
      }

      if (outcome === 'recovered') summary.recovered += 1
      else if (outcome === 'errored') summary.errored += 1
      else if (outcome === 'still_processing') summary.stillProcessing += 1
      else if (outcome === 'unresolved') summary.unresolved += 1
      else summary.failed += 1

      // 'still_processing' repeats every run for slow assets — don't log it.
      if (outcome !== 'still_processing') {
        await ctx.runMutation(internal.clientLogs.createInternal, {
          level: outcome === 'recovered' ? 'info' : 'warn',
          event: `video:reconcile:${outcome}`,
          message: `Stuck ${record.videoStatus} ${record.table} record reconciled: ${outcome}${detail ? ` (${detail})` : ''}`,
          data: {
            table: record.table,
            recordId: record.recordId,
            videoStatus: record.videoStatus,
            stuckForMs: record.stuckForMs,
            muxUploadId: record.muxUploadId,
            muxAssetId: record.muxAssetId,
            muxLiveStreamId: record.muxLiveStreamId,
            detail,
          },
          platform: 'server',
          createdAt: Date.now(),
          userId: record.userId,
        })
      }
    }

    return summary
  },
})

/**
 * Purge muxWebhookEvents older than 30 days.
 *
 * These rows exist only for idempotency (dedup of Mux webhook deliveries).
 * Mux does not re-deliver webhooks after 30 days, so older rows are safe
 * to delete. Batched at 500 per run to stay within Convex mutation limits.
 */
export const purgeOldWebhookEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    let deleted = 0

    const oldEvents = await ctx.db
      .query('muxWebhookEvents')
      .withIndex('by_created_at', (q) => q.lt('createdAt', cutoff))
      .take(500)

    for (const event of oldEvents) {
      await ctx.db.delete(event._id)
      deleted++
    }

    return { deleted, cutoff }
  },
})
