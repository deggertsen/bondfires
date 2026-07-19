/** Bitrate tiers selected from Expo's coarse connection signal. */
export const NETWORK_QUALITY_LADDER = {
  strong: 2_500_000,
  cellular: 1_000_000,
  weak: 600_000,
} as const

export type NetworkQuality = keyof typeof NETWORK_QUALITY_LADDER

export interface NetworkStateSnapshot {
  type?: string
  isConnected?: boolean
  isInternetReachable?: boolean
}

export interface NetworkAssessment extends NetworkStateSnapshot {
  quality: NetworkQuality
  bitrate: number
}

/** Convert a transport/reachability snapshot into the live-streaming tier. */
export function classifyNetworkQuality(state: NetworkStateSnapshot): NetworkQuality {
  if (state.type === 'NONE' || state.isConnected === false || state.isInternetReachable === false) {
    return 'weak'
  }

  if (state.type === 'WIFI' || state.type === 'ETHERNET') {
    return 'strong'
  }

  // Expo does not expose cellular signal strength. Cellular, VPN, Bluetooth,
  // and temporarily unknown transports therefore use the conservative tier.
  return 'cellular'
}

export function toNetworkAssessment(state: NetworkStateSnapshot): NetworkAssessment {
  const quality = classifyNetworkQuality(state)
  return {
    ...state,
    quality,
    bitrate: NETWORK_QUALITY_LADDER[quality],
  }
}

/** Keep a later encoder adjustment (for example thermal recovery) within the
 * network tier selected when the RTMP connection opened. */
export function constrainVideoBitrate(
  requestedBitrate: number,
  networkQuality: NetworkQuality,
): number {
  return Math.min(requestedBitrate, NETWORK_QUALITY_LADDER[networkQuality])
}
