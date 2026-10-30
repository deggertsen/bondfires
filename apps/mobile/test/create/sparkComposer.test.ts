import { describe, expect, it } from 'vitest'
import type { Id } from '../../../../convex/_generated/dataModel'
import { summarizeAudience } from '../../components/create/preRecordingInvite'
import {
  buildCampCtaLabel,
  buildCampPickerList,
  buildPeopleCtaLabel,
  type ComposerCamp,
  filterCampsByName,
  formatMemberCount,
  isPickableCamp,
  orderedPickableCamps,
  resolveInitialSparkMode,
  resolveSelectedCampId,
  suggestCampsToJoin,
} from '../../components/create/sparkComposer'

function camp(
  name: string,
  overrides: Partial<Omit<ComposerCamp, '_id' | 'name'>> = {},
): ComposerCamp {
  return {
    _id: `camp-${name.toLowerCase().replace(/\s+/g, '-')}` as Id<'camps'>,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    access: 'open',
    membership: { status: 'active', role: 'member' },
    rules: { access: {} },
    ...overrides,
  }
}

describe('spark composer mode', () => {
  it('opens on People unless the spark is scoped to a camp', () => {
    expect(resolveInitialSparkMode({})).toBe('people')
    expect(resolveInitialSparkMode({ campId: undefined })).toBe('people')
    expect(resolveInitialSparkMode({ campId: 'camp-trail' })).toBe('camp')
  })
})

describe('camp picker list', () => {
  const trail = camp('Trail Runners')
  const book = camp('Book Club')
  const trading = camp('Trading Post')
  const pending = camp('Morning Pages', { membership: { status: 'pending', role: 'member' } })
  const notJoined = camp('Welcome Fires', { membership: null })
  const inviteMember = camp('Family Only', {
    access: 'invite',
    membership: { status: 'active', role: 'member' },
  })
  const inviteOwner = camp('My Private', {
    access: 'invite',
    membership: { status: 'active', role: 'owner' },
  })

  it('only lets active members pick, and invite-only camps only for their owner', () => {
    expect(isPickableCamp(trail)).toBe(true)
    expect(isPickableCamp(pending)).toBe(false)
    expect(isPickableCamp(notJoined)).toBe(false)
    expect(isPickableCamp(inviteMember)).toBe(false)
    expect(isPickableCamp(inviteOwner)).toBe(true)
  })

  it('puts the last-used camp first, then the rest A–Z, with pending camps apart', () => {
    const list = buildCampPickerList([trail, book, pending, trading, notJoined], trail._id)
    expect(list.lastUsed).toBe(trail)
    expect(list.others.map((entry) => entry.name)).toEqual(['Book Club', 'Trading Post'])
    expect(list.pending).toEqual([pending])
    expect(list.pickableCount).toBe(3)
    expect(orderedPickableCamps(list).map((entry) => entry.name)).toEqual([
      'Trail Runners',
      'Book Club',
      'Trading Post',
    ])
  })

  it('ignores a last-used camp that is no longer pickable', () => {
    const list = buildCampPickerList([trail, book, pending], pending._id)
    expect(list.lastUsed).toBeNull()
    expect(orderedPickableCamps(list).map((entry) => entry.name)).toEqual([
      'Book Club',
      'Trail Runners',
    ])
  })

  it('shows search only above three pickable camps', () => {
    expect(buildCampPickerList([trail, book, trading, pending], null).showSearch).toBe(false)
    expect(buildCampPickerList([trail, book, trading, inviteOwner], null).showSearch).toBe(true)
  })

  it('filters by name, case-insensitively, keeping order', () => {
    expect(filterCampsByName([trail, trading, book], 'tR').map((entry) => entry.name)).toEqual([
      'Trail Runners',
      'Trading Post',
    ])
    expect(filterCampsByName([trail, book], '   ')).toEqual([trail, book])
  })
})

describe('selected camp', () => {
  const ordered = [camp('Trail Runners'), camp('Book Club'), camp('Trading Post')]
  const [trail, book, trading] = ordered as [ComposerCamp, ComposerCamp, ComposerCamp]

  it('prefers the sheet pick, then the scoped camp, then the last used, then the first', () => {
    const ids = { pickedCampId: book._id, paramCampId: trading._id, lastUsedCampId: trail._id }
    expect(resolveSelectedCampId(ordered, ids)).toBe(book._id)
    expect(resolveSelectedCampId(ordered, { ...ids, pickedCampId: null })).toBe(trading._id)
    expect(
      resolveSelectedCampId(ordered, { ...ids, pickedCampId: null, paramCampId: undefined }),
    ).toBe(trail._id)
    expect(
      resolveSelectedCampId(ordered, {
        pickedCampId: null,
        paramCampId: undefined,
        lastUsedCampId: null,
      }),
    ).toBe(trail._id)
  })

  it('falls through ids that are no longer pickable', () => {
    expect(
      resolveSelectedCampId(ordered, {
        pickedCampId: null,
        paramCampId: 'camp-gone',
        lastUsedCampId: book._id,
      }),
    ).toBe(book._id)
    expect(
      resolveSelectedCampId([], { pickedCampId: null, paramCampId: 'x', lastUsedCampId: null }),
    ).toBeNull()
  })
})

describe('camps to join', () => {
  it('suggests unjoined, non-invite camps: Welcome Fires, then gender match, then name', () => {
    const suggestions = suggestCampsToJoin(
      [
        camp('Alpha', { membership: null }),
        camp('Dads Who Cook', {
          membership: null,
          rules: { access: { gender: { value: 'male' } } },
        }),
        camp('Welcome Fires', { membership: null }),
        camp('Secret', { membership: null, access: 'invite' }),
        camp('Joined', {}),
        camp('Pending', { membership: { status: 'pending', role: 'member' } }),
        camp('Zeta', { membership: null }),
      ],
      'male',
    )
    expect(suggestions.map((entry) => entry.name)).toEqual([
      'Welcome Fires',
      'Dads Who Cook',
      'Alpha',
    ])
  })
})

describe('labels', () => {
  const userId = (value: string) => value as Id<'users'>
  const people = [
    { _id: userId('u1'), displayName: 'Mom' },
    { _id: userId('u2'), displayName: 'Sam Rivera' },
  ]

  it('names the audience on the People CTA', () => {
    expect(buildPeopleCtaLabel(summarizeAudience(people, [userId('u1'), userId('u2')]))).toBe(
      'Continue with Mom & Sam',
    )
    expect(buildPeopleCtaLabel(summarizeAudience(people, []))).toBe('Continue to record')
  })

  it('phrases the camp CTA around the trade tag when there is one', () => {
    expect(buildCampCtaLabel('Trail Runners', null)).toBe('Record in Trail Runners')
    expect(buildCampCtaLabel('Trading Post', 'offer')).toBe('Record your offer')
    expect(buildCampCtaLabel('Trading Post', 'need')).toBe('Record your need')
  })

  it('formats member counts', () => {
    expect(formatMemberCount(undefined)).toBeNull()
    expect(formatMemberCount(1)).toBe('1 member')
    expect(formatMemberCount(214)).toBe('214 members')
    expect(formatMemberCount(1000)).toBe('1k members')
    expect(formatMemberCount(1250)).toBe('1.2k members')
  })
})
