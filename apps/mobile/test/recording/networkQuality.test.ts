import { describe, expect, it } from 'vitest'
import {
  classifyNetworkQuality,
  constrainVideoBitrate,
  NETWORK_QUALITY_LADDER,
  toNetworkAssessment,
} from '../../../../packages/app/src/utils/networkQualityPolicy'

describe('networkQuality', () => {
  it.each(['WIFI', 'ETHERNET'])('uses full quality for %s', (type) => {
    expect(
      toNetworkAssessment({
        type,
        isConnected: true,
        isInternetReachable: true,
      }),
    ).toMatchObject({
      quality: 'strong',
      bitrate: NETWORK_QUALITY_LADDER.strong,
    })
  })

  it('uses the conservative cellular tier when cellular is reachable', () => {
    expect(
      toNetworkAssessment({
        type: 'CELLULAR',
        isConnected: true,
        isInternetReachable: true,
      }),
    ).toMatchObject({
      quality: 'cellular',
      bitrate: NETWORK_QUALITY_LADDER.cellular,
    })
  })

  it('uses the weak floor for an explicit connectivity or reachability loss', () => {
    expect(
      classifyNetworkQuality({
        type: 'NONE',
        isConnected: undefined,
        isInternetReachable: undefined,
      }),
    ).toBe('weak')
    expect(
      classifyNetworkQuality({
        type: 'WIFI',
        isConnected: false,
        isInternetReachable: true,
      }),
    ).toBe('weak')
    expect(
      classifyNetworkQuality({
        type: 'CELLULAR',
        isConnected: true,
        isInternetReachable: false,
      }),
    ).toBe('weak')
  })

  it('falls back conservatively when the transport cannot be determined', () => {
    expect(
      toNetworkAssessment({
        type: undefined,
        isConnected: undefined,
        isInternetReachable: undefined,
      }),
    ).toMatchObject({
      quality: 'cellular',
      bitrate: NETWORK_QUALITY_LADDER.cellular,
    })
  })

  it('keeps thermal recovery within the selected network tier', () => {
    expect(constrainVideoBitrate(2_500_000, 'cellular')).toBe(NETWORK_QUALITY_LADDER.cellular)
    expect(constrainVideoBitrate(800_000, 'cellular')).toBe(800_000)
    expect(constrainVideoBitrate(2_500_000, 'strong')).toBe(2_500_000)
  })
})
