import { describe, expect, it, vi } from 'vitest'

vi.mock('@bondfires/app', () => ({
  parsePersonalBondfireInvite: () => null,
}))

import {
  campJoinGatePath,
  createForCampPath,
  resolveAuthRedirect,
  resolveExternalRoute,
} from '../lib/routes'

describe('mobile routes', () => {
  it('round-trips camp join gate redirects through login redirect resolution', () => {
    expect(resolveAuthRedirect(campJoinGatePath('camp-1'))).toEqual({
      pathname: '/(main)/camp/[id]/join',
      params: { id: 'camp-1' },
    })
  })

  it('preserves a selected create camp through the camp join gate redirect', () => {
    const redirect = createForCampPath('camp-1')

    expect(resolveAuthRedirect(campJoinGatePath('camp-1', redirect))).toEqual({
      pathname: '/(main)/camp/[id]/join',
      params: { id: 'camp-1', redirect },
    })

    expect(resolveExternalRoute(redirect)).toEqual({
      pathname: '/(main)/create',
      params: { campId: 'camp-1' },
    })
  })
})
