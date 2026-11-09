import { describe, expect, it } from 'vitest'
import { decideRespondGate } from '../lib/respondGate'

type Context = NonNullable<Parameters<typeof decideRespondGate>[0]>
function campContext(status: string | null = 'active'): Context {
  return {
    bondfire: { campId: 'camp-1' },
    camp: { status: 'active' },
    membership: status ? { status } : null,
  }
}

describe('decideRespondGate', () => {
  it('waits for the query and rejects missing or inaccessible targets', () => {
    expect(decideRespondGate(undefined)).toEqual({ kind: 'loading' })
    expect(decideRespondGate(null)).toEqual({ kind: 'unavailable' })
  })

  it.each(['active', 'grace'] as const)('allows active members in %s camps', (status) => {
    expect(decideRespondGate({ ...campContext(), camp: { status } })).toEqual({ kind: 'respond' })
  })

  it.each([null, 'pending', 'banned', 'rejected', 'something-new'])(
    'requires joining for membership status %s, even with an invite claim',
    (status) => {
      const context = { ...campContext(status), hasInviteClaim: true }
      expect(decideRespondGate(context)).toEqual({ kind: 'join', campId: 'camp-1' })
    },
  )

  it.each(['archived', 'frozen'] as const)(
    'blocks %s camps for members and nonmembers',
    (status) => {
      for (const membership of ['active', null]) {
        expect(decideRespondGate({ ...campContext(membership), camp: { status } })).toEqual({
          kind: 'unavailable',
        })
      }
    },
  )

  it('blocks a missing camp instead of offering to join it', () => {
    expect(decideRespondGate({ ...campContext(), camp: null })).toEqual({ kind: 'unavailable' })
  })

  it('allows a visible Hearth fire without camp membership', () => {
    expect(decideRespondGate({ bondfire: {}, camp: null, membership: null })).toEqual({
      kind: 'respond',
    })
  })
})
