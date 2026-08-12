import { describe, expect, it } from 'vitest'
import {
  accessApprovedBody,
  accessApprovedTitle,
  bodyFromSummary,
  digestSingleBody,
  hearthJoinBody,
  responseLiveBody,
  responsePublishBody,
} from './notificationCopy'
import { buildFcmMessage } from './pushProviders'

describe('bodyFromSummary', () => {
  it('formats third-person summary into Name: Rest', () => {
    expect(bodyFromSummary('David Eggertsen', 'David shares news about the new job')).toBe(
      'David: Shares news about the new job',
    )
  })

  it('handles summaries that omit the speaker name', () => {
    expect(bodyFromSummary('David', 'Shares news about the kids')).toBe(
      'David: Shares news about the kids',
    )
  })
})

describe('responsePublishBody', () => {
  it('includes AI summary when available', () => {
    expect(responsePublishBody('David', 'David shares news about the new job')).toBe(
      'David: Shares news about the new job',
    )
  })

  it('falls back to generic copy when summary is missing', () => {
    expect(responsePublishBody('David', null)).toBe("David added a video to a Bondfire you're in")
    expect(responsePublishBody('David', undefined)).toBe(
      "David added a video to a Bondfire you're in",
    )
  })
})

describe('responseLiveBody', () => {
  it('keeps title-based live copy without summaries', () => {
    expect(responseLiveBody('David', 'Weekend update')).toBe(
      'David is responding in "Weekend update" — watch live or later',
    )
  })
})

describe('digestSingleBody', () => {
  it('includes summary for single response digests', () => {
    expect(
      digestSingleBody({
        creatorName: 'David',
        title: 'Weekend',
        kind: 'response',
        summary: 'David shares news about the kids',
      }),
    ).toBe('David responded: Shares news about the kids')
  })

  it('falls back to title copy without summary', () => {
    expect(
      digestSingleBody({
        creatorName: 'David',
        title: 'Weekend',
        kind: 'response',
      }),
    ).toBe('David responded in "Weekend"')
  })
})

describe('hearthJoinBody', () => {
  it('includes bondfire title when present', () => {
    expect(hearthJoinBody('Maya', 'Family check-in')).toBe('Maya joined "Family check-in"')
  })

  it('falls back without a title', () => {
    expect(hearthJoinBody('Maya', null)).toBe('Maya joined the conversation')
  })
})

describe('accessApprovedTitle', () => {
  it('uses warmer copy', () => {
    expect(accessApprovedTitle('Trailblazers')).toBe('Trailblazers let you in')
    expect(accessApprovedBody()).toBe("You're now a member — tap to look around")
  })
})

describe('buildFcmMessage', () => {
  it('includes android image when avatarUrl is set', () => {
    const message = buildFcmMessage('token-1', {
      title: 'New response',
      body: 'David: Shares news',
      channelId: 'bondfires-responses',
      avatarUrl: 'https://example.com/avatar.jpg',
      data: { type: 'bondfire_response' },
    }) as {
      message: {
        notification: { image?: string }
        android: { notification: { image?: string } }
        data: Record<string, string>
      }
    }

    expect(message.message.notification.image).toBe('https://example.com/avatar.jpg')
    expect(message.message.android.notification.image).toBe('https://example.com/avatar.jpg')
    expect(message.message.data.avatarUrl).toBe('https://example.com/avatar.jpg')
  })

  it('omits image fields when avatarUrl is missing', () => {
    const message = buildFcmMessage('token-1', {
      title: 'New response',
      body: 'Hello',
      channelId: 'bondfires-responses',
    }) as {
      message: {
        notification: { image?: string }
        android: { notification: { image?: string } }
      }
    }

    expect(message.message.notification.image).toBeUndefined()
    expect(message.message.android.notification.image).toBeUndefined()
  })
})
