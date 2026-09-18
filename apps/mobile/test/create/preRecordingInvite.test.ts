import { describe, expect, it } from 'vitest'
import type { Id } from '../../../../convex/_generated/dataModel'
import {
  buildAudienceFilters,
  buildAudienceItems,
  buildAutoTitle,
  isValidInviteEmail,
  MAX_TITLE_LENGTH,
  resolveAudienceFilter,
  selectAudienceItems,
} from '../../components/create/preRecordingInvite'

const userId = (value: string) => value as Id<'users'>

describe('pre-recording invite helpers', () => {
  const candidates = [
    { _id: userId('user-1'), displayName: 'David Eggertsen' },
    { _id: userId('user-2'), name: 'Sarah Smith' },
    { _id: userId('user-3'), displayName: 'Alex Johnson' },
  ]

  it('builds a title from selected users and email handles', () => {
    expect(
      buildAutoTitle(candidates, [userId('user-1'), userId('user-2')], ['jake@example.com']),
    ).toBe('Hey David, Sarah & Jake')
  })

  it('supports email-only invites and summarizes longer audiences', () => {
    expect(buildAutoTitle(candidates, [], ['celeste@example.com'])).toBe('Hey Celeste')
    expect(
      buildAutoTitle(
        candidates,
        [userId('user-1'), userId('user-2'), userId('user-3')],
        ['jake@example.com', 'forge@example.com'],
      ),
    ).toBe('Hey David, Sarah, Alex & 2 more')
  })

  it('deduplicates labels without changing their first-seen casing', () => {
    expect(buildAutoTitle(candidates, [userId('user-1')], ['david@example.com'])).toBe('Hey David')
  })

  it('rejects malformed email addresses', () => {
    expect(isValidInviteEmail('friend@example.com')).toBe(true)
    expect(isValidInviteEmail('missing-domain@')).toBe(false)
    expect(isValidInviteEmail('has whitespace@example.com')).toBe(false)
    expect(isValidInviteEmail(`${'a'.repeat(250)}@example.com`)).toBe(false)
  })

  it('keeps generated titles within the persisted title limit', () => {
    expect(buildAutoTitle(candidates, [], [`${'a'.repeat(80)}@example.com`])).toHaveLength(
      MAX_TITLE_LENGTH,
    )
  })
})

describe('audience rail helpers', () => {
  const family = [
    { _id: userId('user-1'), displayName: 'David Eggertsen' },
    { _id: userId('user-2'), displayName: 'Sarah Smith' },
  ]
  const closeCircle = [
    { _id: userId('user-3'), displayName: 'Alex Johnson' },
    { _id: userId('user-4'), displayName: 'Ryan Lee' },
  ]
  const recent = [
    { _id: userId('user-4'), displayName: 'Ryan Lee' },
    { _id: userId('user-5'), displayName: 'Jake Miller' },
  ]

  it('merges the three lists and keeps the most trusted label per person', () => {
    const items = buildAudienceItems(family, closeCircle, recent)
    expect(items.map((item) => [item.candidate._id, item.group])).toEqual([
      ['user-1', 'family'],
      ['user-2', 'family'],
      ['user-3', 'closeCircle'],
      ['user-4', 'closeCircle'],
      ['user-5', 'recent'],
    ])
    expect(items[0]?.hint).toBe('Family connection')
    expect(items[4]?.hint).toBe('Recent')
  })

  it('lists every person exactly once', () => {
    const items = buildAudienceItems(family, closeCircle, recent)
    expect(new Set(items.map((item) => item.candidate._id)).size).toBe(items.length)
  })

  it('counts each group and drops empty filter chips', () => {
    const items = buildAudienceItems(family, closeCircle, recent)
    expect(buildAudienceFilters(items)).toEqual([
      { key: 'all', label: 'All', count: 5 },
      { key: 'family', label: 'Family', count: 2 },
      { key: 'closeCircle', label: 'Close Circle', count: 2 },
      { key: 'recent', label: 'Recent', count: 1 },
    ])

    const noFamily = buildAudienceItems([], closeCircle, recent)
    expect(buildAudienceFilters(noFamily).map((filter) => filter.key)).toEqual([
      'all',
      'closeCircle',
      'recent',
    ])
  })

  it('falls back to All when the selected filter no longer has candidates', () => {
    const items = buildAudienceItems([], closeCircle, [])
    const filters = buildAudienceFilters(items)
    expect(resolveAudienceFilter('closeCircle', filters)).toBe('closeCircle')
    expect(resolveAudienceFilter('family', filters)).toBe('all')
  })

  it('shows only the filtered group', () => {
    const items = buildAudienceItems(family, closeCircle, recent)
    expect(selectAudienceItems(items, 'family', []).map((item) => item.candidate._id)).toEqual([
      'user-1',
      'user-2',
    ])
    expect(selectAudienceItems(items, 'all', [])).toHaveLength(5)
  })

  it('keeps selected people in the rail when a filter hides them', () => {
    const items = buildAudienceItems(family, closeCircle, recent)
    const selected = selectAudienceItems(items, 'family', [userId('user-5')])
    expect(selected.map((item) => item.candidate._id)).toEqual(['user-5', 'user-1', 'user-2'])
  })
})
