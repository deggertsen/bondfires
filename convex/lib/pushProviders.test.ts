import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildApnsPayload,
  buildFcmMessage,
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
