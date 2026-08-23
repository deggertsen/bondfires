import { describe, expect, it } from 'vitest'
import type { Id } from './_generated/dataModel'
import { getProfileViewCountChanges } from './watchEvents'

const ownerId = 'owner' as Id<'users'>
const viewerId = 'viewer' as Id<'users'>

describe('profile view counting', () => {
  it('counts every non-owner playback start', () => {
    expect(
      getProfileViewCountChanges({
        videoType: 'bondfire',
        ownerId,
        viewerId,
        eventType: 'start',
        ownerTotalViews: 12,
        bondfireViewCount: 4,
      }),
    ).toEqual({ ownerTotalViews: 13, bondfireViewCount: 5 })
    expect(
      getProfileViewCountChanges({
        videoType: 'bondfire',
        ownerId,
        viewerId,
        eventType: 'start',
        ownerTotalViews: 13,
        bondfireViewCount: 5,
      }),
    ).toEqual({ ownerTotalViews: 14, bondfireViewCount: 6 })
  })

  it('attributes response plays to the responder without changing the parent Bondfire count', () => {
    expect(
      getProfileViewCountChanges({
        videoType: 'response',
        ownerId,
        viewerId,
        eventType: 'start',
        ownerTotalViews: undefined,
        bondfireViewCount: 8,
      }),
    ).toEqual({ ownerTotalViews: 1 })
  })

  it('does not count the owner watching their own video', () => {
    expect(
      getProfileViewCountChanges({
        videoType: 'bondfire',
        ownerId,
        viewerId: ownerId,
        eventType: 'start',
        ownerTotalViews: 12,
        bondfireViewCount: 4,
      }),
    ).toBeNull()
  })

  it('does not count playback milestones as additional views', () => {
    for (const eventType of ['milestone_25', 'milestone_50', 'milestone_75', 'complete'] as const) {
      expect(
        getProfileViewCountChanges({
          videoType: 'response',
          ownerId,
          viewerId,
          eventType,
          ownerTotalViews: 12,
        }),
      ).toBeNull()
    }
  })
})
