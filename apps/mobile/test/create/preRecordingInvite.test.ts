import { describe, expect, it } from 'vitest'
import type { Id } from '../../../../convex/_generated/dataModel'
import {
  buildAutoTitle,
  isValidInviteEmail,
  MAX_TITLE_LENGTH,
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
