/**
 * Network quality detection for adaptive live streaming bitrate.
 *
 * RTMP live streaming over weak cellular is the dominant cause of stream
 * drops on Android (telemetry, July 2026). expo-network doesn't expose
 * signal strength, but `type: CELLULAR` + `isInternetReachable` is enough
 * to make a conservative pre-flight decision: explicit loss of connectivity
 * uses the floor, while cellular and unknown transports use a reduced bitrate
 * to give the encoder more headroom against bandwidth fluctuations.
 */

import * as Network from 'expo-network'
import { type NetworkAssessment, toNetworkAssessment } from './networkQualityPolicy'

export * from './networkQualityPolicy'

/**
 * Assess the current network quality for live streaming. Call before
 * starting a recording to pick the right initial bitrate.
 */
export async function assessNetworkQuality(): Promise<NetworkAssessment> {
  let state: Network.NetworkState
  try {
    state = await Network.getNetworkStateAsync()
  } catch {
    return toNetworkAssessment({
      type: undefined,
      isConnected: undefined,
      isInternetReachable: undefined,
    })
  }

  return toNetworkAssessment(state)
}
