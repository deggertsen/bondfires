/**
 * Transport snapshot helpers for live-recording telemetry.
 *
 * Encoder bitrate is not selected directly from transport type. Wi-Fi vs
 * cellular is a weak capacity signal, but it does scope a remembered ABR tier
 * so a prior from one transport is not applied to the other. See
 * liveBitratePolicy.ts for the controller that uses measured throughput.
 */

import * as Network from 'expo-network'

export interface NetworkStateSnapshot {
  type?: string
  isConnected?: boolean
  isInternetReachable?: boolean
}

/** Read the current transport for breadcrumbs and remembered-prior scoping. */
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
