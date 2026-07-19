/**
 * Network quality detection for adaptive live streaming bitrate.
 *
 * RTMP live streaming over weak cellular is the dominant cause of stream
 * drops on Android (telemetry, July 2026). expo-network doesn't expose
 * signal strength, but `type: CELLULAR` + `isInternetReachable` is enough
 * to make a conservative pre-flight decision: if the network says cellular
 * and internet reachability is false or unknown, the stream will almost
 * certainly fail. When it's cellular and reachable, we drop the bitrate to
 * give the encoder more headroom against bandwidth fluctuations.
 */

import * as Network from 'expo-network'

/**
 * Bitrate ladder for network-adaptive quality, independent of thermal
 * mitigation. These values are starting points for the RTMP publisher —
 * the thermal ladder can still step down further on top of this.
 */
export const NETWORK_QUALITY_LADDER = {
  /** Strong connection — WiFi or Ethernet. Use the full default bitrate. */
  strong: 2_500_000,
  /** Cellular with internet — drop to 1 Mbps to handle bandwidth spikes. */
  cellular: 1_000_000,
  /** Weak or unknown reachability — 600 Kbps floor to maximize the chance
   * the stream survives long enough for MUX to capture a valid asset. */
  weak: 600_000,
} as const

export type NetworkQuality = keyof typeof NETWORK_QUALITY_LADDER

export interface NetworkAssessment {
  quality: NetworkQuality
  bitrate: number
  type: Network.NetworkStateType | undefined
  isConnected: boolean | undefined
  isInternetReachable: boolean | undefined
}

/**
 * Assess the current network quality for live streaming. Call before
 * starting a recording to pick the right initial bitrate.
 */
export async function assessNetworkQuality(): Promise<NetworkAssessment> {
  let state: Network.NetworkState
  try {
    state = await Network.getNetworkStateAsync()
  } catch {
    // If we can't read the network state, assume cellular — conservative.
    return {
      quality: 'cellular',
      bitrate: NETWORK_QUALITY_LADDER.cellular,
      type: undefined,
      isConnected: undefined,
      isInternetReachable: undefined,
    }
  }

  const { type, isConnected, isInternetReachable } = state

  // No connection at all — caller should block the recording.
  if (isConnected === false || isInternetReachable === false) {
    return {
      quality: 'weak',
      bitrate: NETWORK_QUALITY_LADDER.weak,
      type,
      isConnected,
      isInternetReachable,
    }
  }

  // WiFi or Ethernet — full quality.
  if (type === Network.NetworkStateType.WIFI || type === Network.NetworkStateType.ETHERNET) {
    return {
      quality: 'strong',
      bitrate: NETWORK_QUALITY_LADDER.strong,
      type,
      isConnected,
      isInternetReachable,
    }
  }

  // Cellular with internet — moderate quality.
  if (type === Network.NetworkStateType.CELLULAR) {
    // isInternetReachable could be true or undefined (Android sometimes
    // reports undefined briefly). If explicitly false, we already returned
    // above. Treat undefined as "probably reachable but uncertain" and
    // use the cellular bitrate.
    return {
      quality: 'cellular',
      bitrate: NETWORK_QUALITY_LADDER.cellular,
      type,
      isConnected,
      isInternetReachable,
    }
  }

  // Unknown type (VPN, Bluetooth, etc.) — treat as cellular for safety.
  return {
    quality: 'cellular',
    bitrate: NETWORK_QUALITY_LADDER.cellular,
    type,
    isConnected,
    isInternetReachable,
  }
}

/**
 * Quick synchronous check for the pre-flight UI warning. Returns true if
 * the network looks too weak to attempt a live recording.
 */
export function isNetworkTooWeakForLive(state: Network.NetworkState): boolean {
  return state.isConnected === false || state.isInternetReachable === false
}

/**
 * Check if the network is cellular (for showing a pre-recording warning
 * even when it's technically reachable).
 */
export function isCellular(state: Network.NetworkState): boolean {
  return state.type === Network.NetworkStateType.CELLULAR
}