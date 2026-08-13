/**
 * Direct APNs + FCM v1 push delivery.
 *
 * Replaces Expo Push API so we can attach rich media (avatars) and control
 * platform-specific payloads. Credentials live in Convex env vars — see
 * `getPushProviderConfig` for the required keys.
 */

export type NativeTokenType = 'apns' | 'fcm'

export interface PushPayload {
  title: string
  body: string
  data?: Record<string, unknown>
  /** Public HTTPS avatar URL for rich media (optional). */
  avatarUrl?: string | null
  /** Android notification channel ID. */
  channelId: string
  /** iOS thread-id for grouping. */
  threadId?: string
  /** Prefer high priority / interruption. */
  highPriority?: boolean
}

export interface PushSendResult {
  successCount: number
  failureCount: number
  /** Tokens that should be deleted (unregistered / invalid). */
  invalidTokens: string[]
  error?: string
}

export interface ApnsConfig {
  keyP8: string
  keyId: string
  teamId: string
  bundleId: string
  production: boolean
}

export interface FcmConfig {
  projectId: string
  clientEmail: string
  privateKey: string
}

export interface PushProviderConfig {
  apns: ApnsConfig | null
  fcm: FcmConfig | null
}

/** Read push credentials from Convex environment variables. */
export function getPushProviderConfig(): PushProviderConfig {
  const keyP8 = process.env.APNS_KEY_P8?.trim()
  const keyId = process.env.APNS_KEY_ID?.trim()
  const teamId = process.env.APNS_TEAM_ID?.trim()
  const bundleId = process.env.APNS_BUNDLE_ID?.trim() || 'org.bondfires'
  const production = (process.env.APNS_PRODUCTION ?? 'true').toLowerCase() !== 'false'

  const apns =
    keyP8 && keyId && teamId
      ? {
          keyP8: normalizePem(keyP8),
          keyId,
          teamId,
          bundleId,
          production,
        }
      : null

  const serviceAccountRaw = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim()
  let fcm: FcmConfig | null = null
  if (serviceAccountRaw) {
    try {
      const parsed = JSON.parse(serviceAccountRaw) as {
        project_id?: string
        client_email?: string
        private_key?: string
      }
      const projectId = process.env.FCM_PROJECT_ID?.trim() || parsed.project_id
      if (projectId && parsed.client_email && parsed.private_key) {
        fcm = {
          projectId,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key.replace(/\\n/g, '\n'),
        }
      }
    } catch {
      fcm = null
    }
  }

  return { apns, fcm }
}

/** Accept raw PEM or base64-encoded PEM for Convex env storage. */
function normalizePem(value: string): string {
  const trimmed = value.trim()
  if (trimmed.includes('BEGIN PRIVATE KEY')) {
    return trimmed.replace(/\\n/g, '\n')
  }
  try {
    const decoded = atob(trimmed)
    if (decoded.includes('BEGIN PRIVATE KEY')) {
      return decoded
    }
  } catch {
    // Not base64 — fall through.
  }
  return trimmed.replace(/\\n/g, '\n')
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
}

async function importPkcs8PrivateKey(
  pem: string,
  algorithm: 'ES256' | 'RS256',
): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  const binary = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0))

  if (algorithm === 'ES256') {
    return await crypto.subtle.importKey(
      'pkcs8',
      binary,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
  }

  return await crypto.subtle.importKey(
    'pkcs8',
    binary,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function signJwt(params: {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  privateKeyPem: string
  algorithm: 'ES256' | 'RS256'
}): Promise<string> {
  const encodedHeader = base64UrlEncodeJson(params.header)
  const encodedPayload = base64UrlEncodeJson(params.payload)
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const key = await importPkcs8PrivateKey(params.privateKeyPem, params.algorithm)
  const data = new TextEncoder().encode(signingInput)

  const signature =
    params.algorithm === 'ES256'
      ? await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data)
      : await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, data)

  // WebCrypto ECDSA returns IEEE P1363 (r||s). APNs expects that for ES256 JWTs.
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

// ── APNs ─────────────────────────────────────────────────────────────

let cachedApnsJwt: { cacheKey: string; token: string; expiresAt: number } | null = null

async function getApnsJwt(config: ApnsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const cacheKey = `${config.teamId}:${config.keyId}`
  if (cachedApnsJwt && cachedApnsJwt.cacheKey === cacheKey && cachedApnsJwt.expiresAt > now + 60) {
    return cachedApnsJwt.token
  }

  const token = await signJwt({
    header: { alg: 'ES256', kid: config.keyId },
    payload: { iss: config.teamId, iat: now },
    privateKeyPem: config.keyP8,
    algorithm: 'ES256',
  })

  // APNs JWTs are valid for up to 60 minutes.
  cachedApnsJwt = { cacheKey, token, expiresAt: now + 50 * 60 }
  return token
}

/** Build the provider-specific APNs body without performing network I/O. */
export function buildApnsPayload(payload: PushPayload): Record<string, unknown> {
  const customData: Record<string, unknown> = { ...(payload.data ?? {}) }
  if (payload.avatarUrl) {
    customData.avatarUrl = payload.avatarUrl
  }

  const body: Record<string, unknown> = {
    aps: {
      alert: {
        title: payload.title,
        body: payload.body,
      },
      sound: 'default',
      'mutable-content': 1,
      ...(payload.threadId ? { 'thread-id': payload.threadId } : {}),
    },
  }

  for (const [key, value] of Object.entries(customData)) {
    if (value === undefined) continue
    body[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return body
}

export async function sendApnsPushNotification(
  tokens: string[],
  payload: PushPayload,
  config: ApnsConfig,
): Promise<PushSendResult> {
  if (tokens.length === 0) {
    return { successCount: 0, failureCount: 0, invalidTokens: [] }
  }

  const jwt = await getApnsJwt(config)
  const host = config.production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'
  const body = buildApnsPayload(payload)
  const invalidTokens: string[] = []
  let successCount = 0
  const errors: string[] = []

  // APNs is one-request-per-token. Parallelize with a modest concurrency cap.
  const CONCURRENCY = 8
  for (let i = 0; i < tokens.length; i += CONCURRENCY) {
    const batch = tokens.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (token) => {
        try {
          const response = await fetch(`https://${host}/3/device/${token}`, {
            method: 'POST',
            headers: {
              authorization: `bearer ${jwt}`,
              'apns-topic': config.bundleId,
              'apns-push-type': 'alert',
              'apns-priority': payload.highPriority === false ? '5' : '10',
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          })

          if (response.status === 200) {
            return { token, ok: true as const }
          }

          let reason = `HTTP ${response.status}`
          try {
            const json = (await response.json()) as { reason?: string }
            if (json.reason) reason = json.reason
          } catch {
            // ignore parse errors
          }

          // BadDeviceToken can also mean a sandbox/production or topic
          // mismatch. Only delete tokens APNs explicitly reports as inactive.
          const invalid = response.status === 410 || reason === 'Unregistered'

          return { token, ok: false as const, reason, invalid }
        } catch (error) {
          return {
            token,
            ok: false as const,
            reason: error instanceof Error ? error.message : String(error),
            invalid: false,
          }
        }
      }),
    )

    for (const result of results) {
      if (result.ok) {
        successCount++
      } else {
        errors.push(`${result.token.slice(0, 12)}…: ${result.reason}`)
        if (result.invalid) invalidTokens.push(result.token)
      }
    }
  }

  return {
    successCount,
    failureCount: tokens.length - successCount,
    invalidTokens,
    error: errors.length > 0 ? errors.slice(0, 5).join('; ') : undefined,
  }
}

// ── FCM v1 ───────────────────────────────────────────────────────────

let cachedFcmAccessToken: { cacheKey: string; token: string; expiresAt: number } | null = null

async function getFcmAccessToken(config: FcmConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const cacheKey = `${config.projectId}:${config.clientEmail}`
  if (
    cachedFcmAccessToken &&
    cachedFcmAccessToken.cacheKey === cacheKey &&
    cachedFcmAccessToken.expiresAt > now + 60
  ) {
    return cachedFcmAccessToken.token
  }

  const assertion = await signJwt({
    header: { alg: 'RS256', typ: 'JWT' },
    payload: {
      iss: config.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    privateKeyPem: config.privateKey,
    algorithm: 'RS256',
  })

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`FCM OAuth error: ${response.status} - ${text}`)
  }

  const json = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) {
    throw new Error('FCM OAuth response did not include an access token')
  }
  cachedFcmAccessToken = {
    cacheKey,
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) - 60,
  }
  return json.access_token
}

function stringifyData(data: Record<string, unknown> | undefined): Record<string, string> {
  if (!data) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    if (serialized !== undefined) out[key] = serialized
  }
  return out
}

export function buildFcmMessage(token: string, payload: PushPayload): Record<string, unknown> {
  const data = stringifyData({
    ...(payload.data ?? {}),
    ...(payload.avatarUrl ? { avatarUrl: payload.avatarUrl } : {}),
  })

  return {
    message: {
      token,
      notification: {
        title: payload.title,
        body: payload.body,
        ...(payload.avatarUrl ? { image: payload.avatarUrl } : {}),
      },
      data,
      android: {
        priority: payload.highPriority === false ? 'NORMAL' : 'HIGH',
        notification: {
          channelId: payload.channelId,
          sound: 'default',
          ...(payload.avatarUrl ? { image: payload.avatarUrl } : {}),
          ...(payload.threadId ? { tag: payload.threadId } : {}),
        },
      },
      apns: {
        // FCM can also fan out to iOS, but we send iOS via APNs directly.
        // Keep this for completeness if an FCM token somehow targets iOS.
        payload: {
          aps: {
            'mutable-content': 1,
            sound: 'default',
            ...(payload.threadId ? { 'thread-id': payload.threadId } : {}),
          },
        },
      },
    },
  }
}

export async function sendFcmPushNotification(
  tokens: string[],
  payload: PushPayload,
  config: FcmConfig,
): Promise<PushSendResult> {
  if (tokens.length === 0) {
    return { successCount: 0, failureCount: 0, invalidTokens: [] }
  }

  const accessToken = await getFcmAccessToken(config)
  const url = `https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`
  const invalidTokens: string[] = []
  let successCount = 0
  const errors: string[] = []

  for (const token of tokens) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildFcmMessage(token, payload)),
      })

      if (response.ok) {
        successCount++
        continue
      }

      const text = await response.text()
      let reason = `HTTP ${response.status}`
      let invalid = false
      try {
        const json = JSON.parse(text) as {
          error?: { status?: string; details?: Array<{ errorCode?: string }> }
        }
        reason = json.error?.status ?? reason
        const errorCode = json.error?.details?.find((d) => d.errorCode)?.errorCode
        // INVALID_ARGUMENT can describe a malformed payload, so deleting the
        // token on that status can wipe valid registrations.
        invalid = errorCode === 'UNREGISTERED' || reason === 'NOT_FOUND'
      } catch {
        // keep text reason
        reason = text.slice(0, 200) || reason
      }

      errors.push(`${token.slice(0, 12)}…: ${reason}`)
      if (invalid) invalidTokens.push(token)
    } catch (error) {
      errors.push(
        `${token.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return {
    successCount,
    failureCount: tokens.length - successCount,
    invalidTokens,
    error: errors.length > 0 ? errors.slice(0, 5).join('; ') : undefined,
  }
}
