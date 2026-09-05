import { describe, expect, it } from 'vitest'
import type { Id } from './_generated/dataModel'
import { getProfileViewCountChanges, validateWatchEventState } from './watchEvents'

const ownerId = 'owner' as Id<'users'>
const viewerId = 'viewer' as Id<'users'>

describe('profile view counting', () => {
  it('computes the increment for a non-owner playback start', () => {
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

describe('watch event state validation', () => {
  it('requires a start before non-start events', () => {
    expect(
      validateWatchEventState({
        eventType: 'milestone_25',
        positionMs: 25_000,
        serverDurationMs: 100_000,
        hasStart: false,
        alreadyRecorded: false,
      }),
    ).toBe('start_required')
  })

  it('rejects spoofed early milestones and completion', () => {
    expect(
      validateWatchEventState({
        eventType: 'milestone_75',
        positionMs: 10_000,
        serverDurationMs: 100_000,
        hasStart: true,
        alreadyRecorded: false,
      }),
    ).toBe('position_too_early')
    expect(
      validateWatchEventState({
        eventType: 'complete',
        positionMs: 50_000,
        serverDurationMs: 100_000,
        hasStart: true,
        alreadyRecorded: false,
      }),
    ).toBe('position_too_early')
  })

  it('fails closed for milestones when authoritative duration is unavailable', () => {
    for (const serverDurationMs of [undefined, 0, Number.NaN]) {
      expect(
        validateWatchEventState({
          eventType: 'complete',
          positionMs: 0,
          serverDurationMs,
          hasStart: true,
          alreadyRecorded: false,
        }),
      ).toBe('duration_unavailable')
    }
  })

  it('rejects duplicate, negative, fractional, and implausibly large positions', () => {
    expect(
      validateWatchEventState({
        eventType: 'start',
        positionMs: 0,
        hasStart: false,
        alreadyRecorded: true,
      }),
    ).toBe('duplicate')
    for (const positionMs of [-1, 1.5, 6 * 60 * 60 * 1_000 + 1]) {
      expect(
        validateWatchEventState({
          eventType: 'start',
          positionMs,
          hasStart: false,
          alreadyRecorded: false,
        }),
      ).toBe('invalid_position')
    }
  })

  it('accepts a plausible sequence using server duration', () => {
    expect(
      validateWatchEventState({
        eventType: 'complete',
        positionMs: 95_000,
        serverDurationMs: 100_000,
        hasStart: true,
        alreadyRecorded: false,
      }),
    ).toBeNull()
  })
})
