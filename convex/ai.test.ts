import { describe, expect, it } from 'vitest'
import { shouldSkipVideoInsights, stripSummaryMetaOpener, videoInsightsPrompt } from './ai'

describe('videoInsightsPrompt', () => {
  it('forbids inferred speaker names because identity is added separately', () => {
    const prompt = videoInsightsPrompt('I finally accepted the new job and start Monday.')

    expect(prompt).toContain('Do not infer or include a speaker name')
    expect(prompt).not.toContain('David')
    expect(prompt).not.toContain('when known')
  })

  it('forbids describing the video instead of its content', () => {
    const prompt = videoInsightsPrompt('I finally accepted the new job and start Monday.')

    expect(prompt).toContain('Never describe the video or the act of sharing')
    expect(prompt).toContain('Person shares a video message')
  })
})

describe('stripSummaryMetaOpener', () => {
  it('strips the meta opener from the operating-room style summary', () => {
    expect(stripSummaryMetaOpener('Person shares a video message from an operating room')).toBe(
      'video message from an operating room',
    )
  })

  it('strips leading-the variants with two passes', () => {
    expect(stripSummaryMetaOpener('The person shares news about his new job')).toBe(
      'news about his new job',
    )
  })

  it('leaves content-first summaries untouched', () => {
    const summary = 'Excited to start the new job Monday and asks how the kids are doing'
    expect(stripSummaryMetaOpener(summary)).toBe(summary)
  })

  it('normalizes whitespace and capitalizes nothing it should not', () => {
    expect(stripSummaryMetaOpener('  Shares   news about the move.  ')).toBe('news about the move.')
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
