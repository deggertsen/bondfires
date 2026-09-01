import { describe, expect, it } from 'vitest'
import {
  hasReachedDailyReportLimit,
  MAX_REPORTS_PER_DAY,
  normalizeReportComments,
  validateReportTargetCount,
} from './reportPolicy'

describe('report authorization policy', () => {
  it('requires exactly one server-resolved content or user target', () => {
    expect(() => validateReportTargetCount([])).toThrow()
    expect(() => validateReportTargetCount(['bondfire', 'user'])).toThrow()
    expect(() => validateReportTargetCount(['bondfire', undefined, undefined])).not.toThrow()
  })

  it('trims bounded evidence comments', () => {
    const comment = `  ${'a'.repeat(30)}  `
    expect(normalizeReportComments(comment)).toHaveLength(30)
    expect(() => normalizeReportComments('too short')).toThrow()
    expect(() => normalizeReportComments('a'.repeat(2_001))).toThrow()
  })

  it('caps daily report submissions', () => {
    expect(hasReachedDailyReportLimit(MAX_REPORTS_PER_DAY - 1)).toBe(false)
    expect(hasReachedDailyReportLimit(MAX_REPORTS_PER_DAY)).toBe(true)
  })
})
