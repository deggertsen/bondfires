import { describe, expect, it } from 'vitest'
import { recordingMaxDurationSeconds } from './recordingLimits'

describe('recordingMaxDurationSeconds', () => {
  it('uses the product cap when the camp or its rules are missing', () => {
    expect(recordingMaxDurationSeconds(null, 10_800_000)).toBe(3600)
    expect(recordingMaxDurationSeconds({}, 10_800_000)).toBe(3600)
    expect(recordingMaxDurationSeconds({ rules: {} }, 10_800_000)).toBe(3600)
    expect(recordingMaxDurationSeconds({ rules: { participation: {} } }, 10_800_000)).toBe(3600)
  })

  it('keeps the tightest of the camp rule, tier, and product cap', () => {
    expect(
      recordingMaxDurationSeconds(
        { rules: { participation: { maxDurationMs: 300_000 } } },
        10_800_000,
      ),
    ).toBe(300)
    expect(
      recordingMaxDurationSeconds(
        { rules: { participation: { maxDurationMs: 300_000 } } },
        120_000,
      ),
    ).toBe(120)
  })
})
