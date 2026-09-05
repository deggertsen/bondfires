import { describe, expect, it, vi } from 'vitest'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import type { ViewerVisibilityContext } from './bondfireVisibility'
import { isBondfireVisibleToViewer, isCampContentVisibleToViewer } from './bondfireVisibility'

function camp(ageBand: 'teen' | 'adult') {
  return {
    _id: 'camp' as Id<'camps'>,
    status: 'active',
    access: 'invite',
    ageBand,
  } as Doc<'camps'>
}

function viewer(birthDate: string, member = true, isAdmin = false): ViewerVisibilityContext {
  return {
    userId: 'user' as Id<'users'>,
    user: { _id: 'user' as Id<'users'>, birthDate } as Doc<'users'>,
    tier: 'free',
    memberCampIds: member ? new Set(['camp' as Id<'camps'>]) : new Set(),
    claimedBondfireIds: new Set(),
    blockedUserIds: new Set(),
    isAdmin,
    campCache: new Map(),
    userCache: new Map(),
  }
}

describe('camp content age isolation', () => {
  it('does not let an existing membership bypass the age band', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'))
    expect(isCampContentVisibleToViewer(camp('adult'), viewer('2010-01-01'))).toBe(false)
    expect(isCampContentVisibleToViewer(camp('teen'), viewer('2000-01-01'))).toBe(false)
    vi.useRealTimers()
  })

  it('denies after the full UTC 18th-birthday day before cleanup runs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'))
    expect(isCampContentVisibleToViewer(camp('teen'), viewer('2008-09-01'))).toBe(true)
    expect(isCampContentVisibleToViewer(camp('teen'), viewer('2008-08-31'))).toBe(true)
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
    expect(isCampContentVisibleToViewer(camp('teen'), viewer('2008-08-31'))).toBe(false)
    vi.useRealTimers()
  })

  it('fails closed for a malformed or missing persisted DOB', () => {
    expect(isCampContentVisibleToViewer(camp('adult'), viewer('invalid'))).toBe(false)
    expect(isCampContentVisibleToViewer(camp('teen'), viewer(''))).toBe(false)
  })

  it('does not let a direct invite claim bypass the boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'))
    const adultCamp = camp('adult')
    const teenViewer = viewer('2010-01-01', false)
    const bondfireId = 'bondfire' as Id<'bondfires'>
    teenViewer.claimedBondfireIds.add(bondfireId)
    teenViewer.campCache.set(adultCamp._id, Promise.resolve(adultCamp))

    const visible = await isBondfireVisibleToViewer(
      {} as QueryCtx,
      {
        _id: bondfireId,
        userId: teenViewer.userId,
        campId: adultCamp._id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Doc<'bondfires'>,
      teenViewer,
    )
    expect(visible).toBe(false)
    vi.useRealTimers()
  })

  it('limits the admin age-boundary bypass to explicit moderation review', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'))
    const teenCamp = camp('teen')
    const adminViewer = viewer('2000-01-01', false, true)
    const creatorId = 'creator' as Id<'users'>
    const bondfire = {
      _id: 'bondfire' as Id<'bondfires'>,
      userId: creatorId,
      campId: teenCamp._id,
      moderationStatus: 'pending_review',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Doc<'bondfires'>
    adminViewer.campCache.set(teenCamp._id, Promise.resolve(teenCamp))
    adminViewer.userCache.set(creatorId, Promise.resolve({ _id: creatorId } as Doc<'users'>))

    expect(await isBondfireVisibleToViewer({} as QueryCtx, bondfire, adminViewer)).toBe(false)
    expect(
      await isBondfireVisibleToViewer({} as QueryCtx, bondfire, adminViewer, {
        allowAdminModerationReview: true,
      }),
    ).toBe(true)
    vi.useRealTimers()
  })

  it('does not grant the moderation review bypass to non-admins', async () => {
    const adultCamp = camp('adult')
    const teenViewer = viewer('2010-01-01', false)
    const creatorId = 'creator' as Id<'users'>
    const bondfire = {
      _id: 'bondfire' as Id<'bondfires'>,
      userId: creatorId,
      campId: adultCamp._id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Doc<'bondfires'>
    teenViewer.campCache.set(adultCamp._id, Promise.resolve(adultCamp))
    teenViewer.userCache.set(creatorId, Promise.resolve({ _id: creatorId } as Doc<'users'>))

    expect(
      await isBondfireVisibleToViewer({} as QueryCtx, bondfire, teenViewer, {
        allowAdminModerationReview: true,
      }),
    ).toBe(false)
  })
})
