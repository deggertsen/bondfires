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

function viewer(birthDate: string, member = true): ViewerVisibilityContext {
  return {
    userId: 'user' as Id<'users'>,
    user: { _id: 'user' as Id<'users'>, birthDate } as Doc<'users'>,
    tier: 'free',
    memberCampIds: member ? new Set(['camp' as Id<'camps'>]) : new Set(),
    claimedBondfireIds: new Set(),
    campCache: new Map(),
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
        campId: adultCamp._id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Doc<'bondfires'>,
      teenViewer,
    )
    expect(visible).toBe(false)
    vi.useRealTimers()
  })
})
