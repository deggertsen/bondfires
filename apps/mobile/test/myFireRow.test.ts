import { describe, expect, it } from 'vitest'
import { getMyFireRowCreatorName } from '../lib/myFireRow'

const thread = {
  userId: 'viewer',
  creatorName: 'Viewer',
  unread: true,
  firstUnwatchedResponder: { _id: 'responder', displayName: 'Responder', name: 'Full name' },
}

describe('Home and My Fires row author', () => {
  it('uses the responder on unread rows and the creator on read rows', () => {
    expect(getMyFireRowCreatorName(thread, 'viewer')).toBe('Responder')
    expect(getMyFireRowCreatorName({ ...thread, unread: false }, 'viewer')).toBe('Viewer')
  })

  it('uses the account name when the display name is blank', () => {
    expect(
      getMyFireRowCreatorName(
        {
          ...thread,
          firstUnwatchedResponder: { ...thread.firstUnwatchedResponder, displayName: ' ' },
        },
        'viewer',
      ),
    ).toBe('Full name')
  })

  it('never falls back to the viewer on unread rows', () => {
    for (const firstUnwatchedResponder of [null, undefined, { _id: 'viewer', name: 'Viewer' }]) {
      expect(getMyFireRowCreatorName({ ...thread, firstUnwatchedResponder }, 'viewer')).toBe(
        'Anonymous',
      )
    }
  })

  it('keeps the creator fallback for invites and older server payloads', () => {
    expect(
      getMyFireRowCreatorName(
        {
          ...thread,
          userId: 'inviter',
          creatorName: 'Inviter',
          firstUnwatchedResponder: null,
        },
        'viewer',
      ),
    ).toBe('Inviter')
  })
})
