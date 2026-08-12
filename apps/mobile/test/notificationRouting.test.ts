import { describe, expect, it, vi } from 'vitest'

vi.mock('@bondfires/app', () => ({
  parsePersonalBondfireInvite: () => null,
}))

import { resolveNotificationRoute } from '../lib/notificationRouting'

describe('notification routing', () => {
  it('opens the requested bondfire video when the payload has a concrete target', () => {
    expect(
      resolveNotificationRoute({
        type: 'response',
        bondfireId: 'bondfire-1',
        bondfireVideoId: 'video-1',
      }),
    ).toEqual({
      pathname: '/(main)/bondfire/[id]',
      params: { id: 'bondfire-1', videoId: 'video-1' },
    })
  })

  it.each([
    'camp_access_request',
    'camp_access_approved',
    'camp_lifecycle',
  ])('opens the camp for %s notifications', (type) => {
    expect(resolveNotificationRoute({ type, campId: 'camp-1' })).toEqual({
      pathname: '/(main)/camp/[id]',
      params: { id: 'camp-1' },
    })
  })

  it('allows known screen routes from notification payloads', () => {
    expect(resolveNotificationRoute({ screen: '/(main)/(tabs)/my-fires' })).toBe(
      '/(main)/(tabs)/my-fires',
    )
  })

  it.each(['digest', 'nudge'])('opens the feed for a multi-item %s', (type) => {
    expect(resolveNotificationRoute({ type })).toBe('/(main)/(tabs)/feed')
  })

  it('falls back to the feed when a digest includes an invalid screen', () => {
    expect(resolveNotificationRoute({ type: 'digest', screen: '/not-allowed' })).toBe(
      '/(main)/(tabs)/feed',
    )
  })

  it('rejects malformed identifiers and unknown payloads', () => {
    expect(resolveNotificationRoute({ campId: { unexpected: true } })).toBeNull()
    expect(resolveNotificationRoute({ type: 'unknown' })).toBeNull()
    expect(resolveNotificationRoute(null)).toBeNull()
  })
})
