import { describe, expect, it, vi } from 'vitest'

vi.mock('@bondfires/app', () => ({
  parsePersonalBondfireInvite: () => null,
}))

import {
  campJoinGatePath,
  createForCampPath,
  createRespondToPath,
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

  it('allowlists the exact respond recorder destination for the camp join gate redirect', () => {
    const redirect = createRespondToPath('bf-1')
    expect(redirect).toBe('/(main)/create?respondTo=bf-1')

    expect(resolveExternalRoute(redirect)).toEqual({
      pathname: '/(main)/create',
      params: { respondTo: 'bf-1' },
    })

    expect(resolveExternalRoute(campJoinGatePath('camp-1', redirect))).toEqual({
      pathname: '/(main)/camp/[id]/join',
      params: { id: 'camp-1', redirect },
    })
  })

  it('rejects respond paths with extra or unknown query params', () => {
    expect(resolveExternalRoute('/(main)/create?respondTo=bf-1&campId=camp-1')).toBeNull()
    expect(resolveExternalRoute('/(main)/create?respondTo=')).toBeNull()
    expect(resolveExternalRoute('/(main)/create?foo=bar')).toBeNull()
    expect(resolveExternalRoute('/(main)/create?respondTo=bf-1#x')).toBeNull()
  })

  it('leaves a bare bondfire id unresolved so the join gate falls back to the bondfire screen', () => {
    expect(resolveExternalRoute('bf-1')).toBeNull()
  })

  it('allowlists a nested family invitation without treating it as a regular invite', () => {
    expect(resolveExternalRoute('/invite/family/family-0123456789abcdef0123456789abcdef')).toEqual({
      pathname: '/invite/family/[code]',
      params: { code: 'family-0123456789abcdef0123456789abcdef' },
    })
  })
})
