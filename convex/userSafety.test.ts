import { describe, expect, it } from 'vitest'
import type { Id } from './_generated/dataModel'
import { mergeBlockedUserIds } from './userSafety'

describe('service-wide blocking policy', () => {
  it('treats outgoing and incoming blocks as a bidirectional visibility boundary', () => {
    const outgoingId = 'outgoing' as Id<'users'>
    const incomingId = 'incoming' as Id<'users'>
    const ids = mergeBlockedUserIds([{ blockedUserId: outgoingId }], [{ blockerId: incomingId }])
    expect(ids).toEqual(new Set([outgoingId, incomingId]))
  })
})
