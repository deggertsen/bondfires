import { httpRouter } from 'convex/server'
import { internal } from './_generated/api'
import { httpAction } from './_generated/server'
import { auth } from './auth'

const http = httpRouter()

auth.addHttpRoutes(http)

function parseMuxSignatureHeader(header: string | null): {
  timestamp?: string
  signatures: string[]
} {
  const parts = header?.split(',') ?? []
  const signatures: string[] = []
  let timestamp: string | undefined

  for (const part of parts) {
    const [key, value] = part.split('=')
    if (key === 't') {
      timestamp = value
    } else if (key === 'v1' && value) {
      signatures.push(value)
    }
  }

  return { timestamp, signatures }
}

function hexFromBuffer(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false
  }

  let result = 0
  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }

  return result === 0
}

async function verifyMuxSignature(args: {
  payload: string
  signatureHeader: string | null
  secret: string
}): Promise<boolean> {
  const { timestamp, signatures } = parseMuxSignatureHeader(args.signatureHeader)
  if (!timestamp || signatures.length === 0) {
    return false
  }

  const signedPayload = `${timestamp}.${args.payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(args.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = hexFromBuffer(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload)),
  )

  return signatures.some((candidate) => timingSafeEqualHex(signature, candidate))
}

http.route({
  path: '/mux/webhook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.MUX_WEBHOOK_SECRET
    if (!webhookSecret) {
      return new Response('Mux webhook secret is not configured', { status: 500 })
    }

    const payload = await request.text()
    const isVerified = await verifyMuxSignature({
      payload,
      signatureHeader: request.headers.get('mux-signature'),
      secret: webhookSecret,
    })

    if (!isVerified) {
      return new Response('Invalid signature', { status: 401 })
    }

    const event = JSON.parse(payload) as {
      id?: unknown
      type?: unknown
      data?: unknown
      object?: unknown
    }

    if (typeof event.id !== 'string' || typeof event.type !== 'string') {
      return new Response('Invalid event payload', { status: 400 })
    }

    await ctx.runMutation(internal.videos.handleMuxWebhookEvent, {
      eventId: event.id,
      eventType: event.type,
      dataJson: JSON.stringify(event.data ?? {}),
      // For video.asset.track.* events, `data` is the track and the parent
      // asset id only appears here.
      objectJson: JSON.stringify(event.object ?? {}),
    })

    return new Response('ok', { status: 200 })
  }),
})

export default http
