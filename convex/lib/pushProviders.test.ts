import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildApnsPayload,
  buildFcmMessage,
  isMalformedNativePushToken,
  sendApnsPushNotification,
  sendFcmPushNotification,
} from './pushProviders'

function toPem(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  const base64 =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`
}

async function generatePrivateKeyPem(algorithm: 'ES256' | 'RS256'): Promise<string> {
  const keyPair =
    algorithm === 'ES256'
      ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
          'sign',
          'verify',
        ])
      : await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
          },
          true,
          ['sign', 'verify'],
        )
  return toPem(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('provider payloads', () => {
  it('builds an APNs alert with root-level routing data and rich-media flags', () => {
    expect(
      buildApnsPayload({
        title: 'New response',
        body: 'David: Shares news',
        channelId: 'bondfires-responses',
        threadId: 'bondfires-responses',
        avatarUrl: 'https://example.com/avatar.jpg',
        data: { type: 'bondfire_response', nested: { id: 1 }, ignored: undefined },
      }),
    ).toEqual({
      aps: {
        alert: { title: 'New response', body: 'David: Shares news' },
        sound: 'default',
        'mutable-content': 1,
        'thread-id': 'bondfires-responses',
      },
      type: 'bondfire_response',
      nested: '{"id":1}',
      avatarUrl: 'https://example.com/avatar.jpg',
    })
  })

  it('builds an FCM message with string-only data and optional image fields', () => {
    const richMessage = buildFcmMessage('token-1', {
      title: 'New response',
      body: 'David: Shares news',
      channelId: 'bondfires-responses',
      avatarUrl: 'https://example.com/avatar.jpg',
      data: { type: 'bondfire_response', nested: { id: 1 }, ignored: undefined },
    }) as {
      message: {
        notification: { image?: string }
        android: { notification: { image?: string } }
        data: Record<string, string>
      }
    }

    expect(richMessage.message.notification.image).toBe('https://example.com/avatar.jpg')
    expect(richMessage.message.android.notification.image).toBe('https://example.com/avatar.jpg')
    expect(richMessage.message.data).toEqual({
      type: 'bondfire_response',
      nested: '{"id":1}',
      avatarUrl: 'https://example.com/avatar.jpg',
    })

    const plainMessage = buildFcmMessage('token-1', {
      title: 'New response',
      body: 'Hello',
      channelId: 'bondfires-responses',
    }) as {
      message: {
        notification: { image?: string }
        android: { notification: { image?: string } }
      }
    }
    expect(plainMessage.message.notification.image).toBeUndefined()
    expect(plainMessage.message.android.notification.image).toBeUndefined()
  })
})

describe('provider delivery results', () => {
  it('reports exact APNs successes and only deletes explicitly unregistered tokens', async () => {
    const keyP8 = await generatePrivateKeyPem('ES256')
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlParts = String(input).split('/')
      const token = urlParts[urlParts.length - 1]
      if (token === 'ok-token') return new Response(null, { status: 200 })
      if (token === 'stale-token') {
        return Response.json({ reason: 'Unregistered' }, { status: 410 })
      }
      return Response.json({ reason: 'BadDeviceToken' }, { status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendApnsPushNotification(
      ['ok-token', 'stale-token', 'wrong-environment-token'],
      { title: 'Hello', body: 'World', channelId: 'bondfires-default' },
      {
        keyP8,
        keyId: 'KEY123',
        teamId: 'TEAM123',
        bundleId: 'org.bondfires',
        production: true,
      },
    )

    expect(result.successCount).toBe(1)
    expect(result.failureCount).toBe(2)
    expect(result.invalidTokens).toEqual(['stale-token'])
    expect(result.error).toContain('BadDeviceToken')
    expect(result.tokenResults).toEqual([
      { token: 'ok-token', outcome: 'success' },
      { token: 'stale-token', outcome: 'invalid' },
      { token: 'wrong-environment-token', outcome: 'token_failure' },
    ])
  })

  it('reports exact FCM successes without deleting tokens for payload errors', async () => {
    const privateKey = await generatePrivateKeyPem('RS256')
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('oauth2.googleapis.com')) {
        return Response.json({ access_token: 'access-token', expires_in: 3600 })
      }

      const request = JSON.parse(String(init?.body)) as { message: { token: string } }
      if (request.message.token === 'ok-token') return Response.json({ name: 'sent' })
      if (request.message.token === 'stale-token') {
        return Response.json(
          {
            error: {
              status: 'NOT_FOUND',
              details: [{ errorCode: 'UNREGISTERED' }],
            },
          },
          { status: 404 },
        )
      }
      return Response.json(
        {
          error: {
            status: 'INVALID_ARGUMENT',
            details: [{ errorCode: 'INVALID_ARGUMENT' }],
          },
        },
        { status: 400 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendFcmPushNotification(
      ['ok-token', 'stale-token', 'valid-token-with-bad-payload'],
      { title: 'Hello', body: 'World', channelId: 'bondfires-default' },
      {
        projectId: 'bondfires-test',
        clientEmail: 'push@example.com',
        privateKey,
      },
    )

    expect(result.successCount).toBe(1)
    expect(result.failureCount).toBe(2)
    expect(result.invalidTokens).toEqual(['stale-token'])
    expect(result.error).toContain('INVALID_ARGUMENT')
  })
})

describe('FCM INVALID_ARGUMENT classification', () => {
  const tokenMessage = 'The registration token is not a valid FCM registration token'
  const fcmDetail = {
    '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
    errorCode: 'INVALID_ARGUMENT',
  }
  const payloadDetail = {
    '@type': 'type.googleapis.com/google.rpc.BadRequest',
    fieldViolations: [{ field: 'message.data[0].value', description: 'Expected string' }],
  }
  it.each([
    {
      name: 'explicit FCM token rejection',
      message: tokenMessage,
      details: [fcmDetail],
      outcome: 'invalid',
    },
    {
      name: 'token message without details',
      message: tokenMessage,
      details: [],
      outcome: 'invalid',
    },
    {
      name: 'token field violation',
      message: '',
      details: [
        {
          ...payloadDetail,
          fieldViolations: [{ field: 'message.token', description: 'Invalid token' }],
        },
      ],
      outcome: 'invalid',
    },
    {
      name: 'payload field violation',
      message: 'Invalid value',
      details: [payloadDetail],
      outcome: 'other_failure',
    },
    {
      name: 'payload evidence overrides FCM code',
      message: tokenMessage,
      details: [fcmDetail, payloadDetail],
      outcome: 'other_failure',
    },
    {
      name: 'payload message without details',
      message: 'Message too big',
      details: [fcmDetail],
      outcome: 'other_failure',
    },
    { name: 'bare FCM code', message: '', details: [fcmDetail], outcome: 'other_failure' },
    { name: 'bare status', message: '', details: [], outcome: 'other_failure' },
    {
      name: 'unrecognized request error',
      message: 'Request contains an invalid argument.',
      details: [fcmDetail],
      outcome: 'other_failure',
    },
  ])('$name', async ({ message, details, outcome }) => {
    const privateKey = await generatePrivateKeyPem('RS256')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes('oauth2.googleapis.com')) {
          return Response.json({ access_token: 'access-token', expires_in: 3600 })
        }
        return Response.json(
          { error: { status: 'INVALID_ARGUMENT', message, details } },
          { status: 400 },
        )
      }),
    )
    const result = await sendFcmPushNotification(
      ['registration-token'],
      { title: 'Hello', body: 'World', channelId: 'bondfires-default' },
      { projectId: 'classification-test', clientEmail: 'push@example.com', privateKey },
    )
    expect(result.invalidTokens).toEqual(outcome === 'invalid' ? ['registration-token'] : [])
    expect(result.tokenResults).toEqual([{ token: 'registration-token', outcome }])
    expect(result.failureCount).toBe(1)
  })

  it('does not delete or strike tokens for project, auth, quota, server, or network failures', async () => {
    const privateKey = await generatePrivateKeyPem('RS256')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('oauth2.googleapis.com'))
          return Response.json({ access_token: 'access-token' })
        const { message } = JSON.parse(String(init?.body)) as { message: { token: string } }
        if (message.token === 'network') throw new Error('Network unavailable')
        return Response.json({ error: { status: message.token } }, { status: 500 })
      }),
    )
    const tokens = ['NOT_FOUND', 'UNAUTHENTICATED', 'QUOTA_EXCEEDED', 'UNAVAILABLE', 'network']
    const result = await sendFcmPushNotification(
      tokens,
      { title: 'Hello', body: 'World', channelId: 'bondfires-default' },
      { projectId: 'classification-test', clientEmail: 'push@example.com', privateKey },
    )
    expect(result.invalidTokens).toEqual([])
    expect(result.tokenResults).toEqual(
      tokens.map((token) => ({ token, outcome: 'other_failure' })),
    )
  })
})

describe('native token shapes', () => {
  it.each([
    'ExponentPushToken[legacy]',
    'ExpoPushToken[legacy]',
    '',
    'token with spaces',
    '{unknown}',
  ])('rejects %s before native delivery', (token) => {
    expect(isMalformedNativePushToken(token, 'fcm')).toBe(true)
    expect(isMalformedNativePushToken(token, 'apns')).toBe(true)
  })
  it('accepts opaque FCM tokens and variable-length APNs bytes', () => {
    expect(isMalformedNativePushToken('opaque_FCM:token-123', 'fcm')).toBe(false)
    expect(isMalformedNativePushToken('a1'.repeat(32), 'apns')).toBe(false)
    expect(isMalformedNativePushToken('a1'.repeat(64), 'apns')).toBe(false)
    expect(isMalformedNativePushToken('unknown-shape', 'apns')).toBe(true)
  })
})
