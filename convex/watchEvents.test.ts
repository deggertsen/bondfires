import { describe, expect, it } from 'vitest'
import type { Id } from './_generated/dataModel'
import { shouldCountProfileView } from './watchEvents'

const ownerId = 'owner' as Id<'users'>
const viewerId = 'viewer' as Id<'users'>

describe('profile view counting', () => {
  it('counts every non-owner playback start', () => {
    const view = { videoType: 'bondfire' as const, eventType: 'start' as const, ownerId, viewerId }

    expect(shouldCountProfileView(view)).toBe(true)
    expect(shouldCountProfileView(view)).toBe(true)
  })

  it('uses the same rule for Bondfire and response owners', () => {
    expect(
      shouldCountProfileView({ videoType: 'bondfire', eventType: 'start', ownerId, viewerId }),
    ).toBe(true)
    expect(
      shouldCountProfileView({ videoType: 'response', eventType: 'start', ownerId, viewerId }),
    ).toBe(true)
  })

  it('does not count the owner watching their own video', () => {
    expect(
      shouldCountProfileView({
        videoType: 'bondfire',
        eventType: 'start',
        ownerId,
        viewerId: ownerId,
      }),
    ).toBe(false)
  })

  it('does not count playback milestones as additional views', () => {
    expect(
      shouldCountProfileView({
        videoType: 'response',
        eventType: 'milestone_25',
        ownerId,
        viewerId,
      }),
    ).toBe(false)
    expect(
      shouldCountProfileView({
        videoType: 'response',
        eventType: 'complete',
        ownerId,
        viewerId,
      }),
    ).toBe(false)
  })
})
