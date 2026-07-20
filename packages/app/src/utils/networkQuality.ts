/**
 * Transport snapshot helpers for live-recording telemetry.
 *
 * Encoder bitrate is NOT selected from transport type. Wi‑Fi vs cellular is a
 * weak prior and does not reflect uplink capacity — see liveBitratePolicy.ts
 * for the OBS-style adaptive bitrate controller that uses measured throughput.
 */

import * as Network from 'expo-network'

export interface NetworkStateSnapshot {
  type?: string
  isConnected?: boolean
  isInternetReachable?: boolean
}

/**
 * Read the current transport for breadcrumbs only (never for bitrate tiers).
 */
export async function assessNetworkTransport(): Promise<NetworkStateSnapshot> {
  try {
    const state = await Network.getNetworkStateAsync()
    return {
      type: state.type,
      isConnected: state.isConnected,
      isInternetReachable: state.isInternetReachable,
    }
  } catch {
    return {
      type: undefined,
      isConnected: undefined,
      isInternetReachable: undefined,
    }
  }
}

/** @deprecated Use assessNetworkTransport — bitrate is no longer derived here. */
export const assessNetworkQuality = assessNetworkTransport
