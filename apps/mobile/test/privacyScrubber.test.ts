import { describe, expect, it } from 'vitest'
import {
  redactSensitiveText,
  scrubTelemetryValue,
} from '../../../packages/app/src/services/privacyScrubber'

describe('telemetry privacy scrubber', () => {
  it('redacts identity, DOBs, bearer credentials, URLs, and both invite formats from text', () => {
    const value =
      'email person@example.com birth date 2008-08-31 Bearer abc.def.ghi https://video.example/file.mp4 bf-abcd-efgh-ijkl-mnop-qrst amber-river-torch'
    const redacted = redactSensitiveText(value)
    expect(redacted).not.toContain('person@example.com')
    expect(redacted).not.toContain('2008-08-31')
    expect(redacted).not.toContain('abc.def.ghi')
    expect(redacted).not.toContain('video.example')
    expect(redacted).not.toContain('bf-abcd')
    expect(redacted).not.toContain('amber-river-torch')
  })

  it('drops sensitive nested fields while preserving bounded diagnostics', () => {
    expect(
      scrubTelemetryValue({
        reason: 'network_timeout',
        email: 'person@example.com',
        authToken: 'secret',
        nested: { playbackUrl: 'https://video.example/file.m3u8', attempts: 2 },
      }),
    ).toEqual({
      reason: 'network_timeout',
      email: '[Redacted]',
      authToken: '[Redacted]',
      nested: { playbackUrl: '[Redacted]', attempts: 2 },
    })
  })
})
