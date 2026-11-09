import { describe, expect, it, vi } from 'vitest'

vi.mock('@bondfires/app', () => ({
  parsePersonalBondfireInvite: () => null,
}))

import { decideRespondGate, respondGateHref } from '../lib/respondGate'
import { createRespondToPath, resolveExternalRoute } from '../lib/routes'

describe('decideRespondGate', () => {
  it('lets an active camp member respond', () => {
    expect(decideRespondGate({ campId: 'camp-1', membershipStatus: 'active' })).toEqual({
      kind: 'respond',
    })
  })

  it('sends a viewer with no membership row to the join gate', () => {
    expect(decideRespondGate({ campId: 'camp-1', membershipStatus: null })).toEqual({
      kind: 'join',
      campId: 'camp-1',
    })
    expect(decideRespondGate({ campId: 'camp-1', membershipStatus: undefined })).toEqual({
      kind: 'join',
      campId: 'camp-1',
    })
  })

  it('treats every non-active status as not joined, matching the server rule', () => {
    for (const membershipStatus of ['pending', 'banned', 'rejected', 'something-new']) {
      expect(decideRespondGate({ campId: 'camp-1', membershipStatus })).toEqual({
        kind: 'join',
        campId: 'camp-1',
      })
    }
  })

  it('leaves bondfires without a camp alone', () => {
    expect(decideRespondGate({ campId: undefined, membershipStatus: null })).toEqual({
      kind: 'respond',
    })
    expect(decideRespondGate({ campId: null, membershipStatus: 'pending' })).toEqual({
      kind: 'respond',
    })
  })
})

describe('respondGateHref', () => {
  it('opens the respond recorder directly when allowed', () => {
    expect(respondGateHref('bf-1', { kind: 'respond' })).toEqual({
      pathname: '/(main)/create',
      params: { respondTo: 'bf-1' },
    })
  })

  it('opens the existing join gate with the respond recorder as the post-join redirect', () => {
    const href = respondGateHref('bf-1', { kind: 'join', campId: 'camp-1' })
    expect(href).toEqual({
      pathname: '/(main)/camp/[id]/join',
      params: { id: 'camp-1', redirect: createRespondToPath('bf-1') },
    })

    // The join gate resolves its redirect through the external-route allowlist.
    expect(resolveExternalRoute(createRespondToPath('bf-1'))).toEqual({
      pathname: '/(main)/create',
      params: { respondTo: 'bf-1' },
    })
  })
})
