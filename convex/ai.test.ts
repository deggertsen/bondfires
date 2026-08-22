import { describe, expect, it } from 'vitest'
import { shouldSkipVideoInsights, videoInsightsPrompt } from './ai'

describe('videoInsightsPrompt', () => {
  it('forbids inferred speaker names because identity is added separately', () => {
    const prompt = videoInsightsPrompt('I finally accepted the new job and start Monday.')

    expect(prompt).toContain('Do not infer or include a speaker name')
    expect(prompt).not.toContain('David')
    expect(prompt).not.toContain('when known')
  })
})

describe('shouldSkipVideoInsights', () => {
  it('skips existing summaries during normal webhook processing', () => {
    expect(shouldSkipVideoInsights('Existing summary', undefined)).toBe(true)
  })

  it('allows an existing summary to be repaired explicitly', () => {
    expect(shouldSkipVideoInsights('Existing summary', true)).toBe(false)
  })

  it('processes records that do not have a summary', () => {
    expect(shouldSkipVideoInsights(undefined, undefined)).toBe(false)
  })
})
