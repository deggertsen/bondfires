import { describe, expect, it } from 'vitest'
import { resolveNotificationPrefs } from './notifications'

describe('resolveNotificationPrefs', () => {
  it('defaults new response preferences on for new users', () => {
    expect(resolveNotificationPrefs(undefined).responses).toBe(true)
  })

  it('preserves old camp activity opt-outs for the new responses toggle', () => {
    expect(resolveNotificationPrefs({ recordingActivity: false }).responses).toBe(false)
  })

  it('lets the split responses toggle override the old combined preference', () => {
    expect(resolveNotificationPrefs({ recordingActivity: false, responses: true }).responses).toBe(
      true,
    )
  })
})
