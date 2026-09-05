import { describe, expect, it } from 'vitest'
import { scrubSentryEvent } from '../lib/monitoringPrivacy'

describe('Sentry event privacy', () => {
  it('allowlists app/OS context and preserves matching scrubbed debug-ID locations', () => {
    const filename = 'https://bundle.example/index.bundle?token=secret'
    const debugId = '12345678-1234-4234-8234-123456789abc'
    const event = scrubSentryEvent({
      contexts: {
        app: { app_version: '1.2.3', arbitrary: 'person@example.com' },
        os: { name: 'iOS', arbitrary: 'secret' },
      },
      debug_meta: {
        images: [
          { type: 'sourcemap', code_file: filename, debug_id: debugId, arbitrary: 'secret' },
        ],
      },
      exception: { values: [{ stacktrace: { frames: [{ filename }] } }] },
    })
    expect(event.contexts?.app).toEqual({ app_version: '1.2.3' })
    expect(event.contexts?.os).toEqual({ name: 'iOS' })
    expect(event.debug_meta).toEqual({
      images: [{ type: 'sourcemap', code_file: 'index.bundle', debug_id: debugId }],
    })
    expect(event.exception?.values?.[0].stacktrace?.frames?.[0].filename).toBe('index.bundle')
    expect(JSON.stringify(event)).not.toContain('secret')
  })
  it('removes PII-bearing containers and scrubs exception/breadcrumb text', () => {
    const event = scrubSentryEvent({
      message: 'Failed for person@example.com born 2008-08-31 at https://video.example/file.mp4',
      user: { email: 'person@example.com' },
      request: { headers: { authorization: 'Bearer token' } },
      extra: { inviteCode: 'amber-river-torch' },
      tags: {
        route: 'bondfires://invite/bf-abcd-efgh-ijkl-mnop-qrst',
        screen: 'person@example.com',
        'person@example.com': 'unsafe key',
        safeCount: 2,
        unsafeObject: { email: 'person@example.com' },
      },
      breadcrumbs: [{ message: 'open bondfires://invite/amber-river-torch', data: { token: 'x' } }],
      exception: {
        values: [
          {
            value: 'bad bf-abcd-efgh-ijkl-mnop-qrst for DOB 2008-08-31',
            stacktrace: { frames: [] },
          },
        ],
      },
    })
    expect(event.user).toBeUndefined()
    expect(event.request).toBeUndefined()
    expect(event.extra).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain('person@example.com')
    expect(JSON.stringify(event)).not.toContain('2008-08-31')
    expect(JSON.stringify(event)).not.toContain('video.example')
    expect(JSON.stringify(event)).not.toContain('amber-river-torch')
    expect(JSON.stringify(event)).not.toContain('bf-abcd')
    expect(event.tags.safeCount).toBe('2')
    expect(event.tags.unsafeObject).toBeUndefined()
  })
})
