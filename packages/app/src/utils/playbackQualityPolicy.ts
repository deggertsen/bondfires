export type PlaybackQuality = 720 | 1080
export type PlaybackResolution = 480 | PlaybackQuality

/** Trial thresholds: lower quickly, recover only after a full stable minute. */
export function createPlaybackQualityPolicy() {
  let warmSince: number | null = null
  let coolSince: number | null = null
  let heatLimited = false
  let networkLimited = false
  let stableSince: number | null = null
  let stalls: number[] = []
  let lastThermalAt: number | null = null

  return {
    thermal(level: number, now: number) {
      // Missing thermal support must not be interpreted as a cool reading.
      if (level < 0) {
        warmSince = null
        coolSince = null
        return
      }
      // A suspended app cannot establish sustained warmth or cooldown.
      if (lastThermalAt !== null && now - lastThermalAt > 20_000) {
        warmSince = null
        coolSince = null
      }
      lastThermalAt = now
      if (level >= 1) {
        coolSince = null
        warmSince ??= now
        if (level >= 2 || now - warmSince >= 20_000) heatLimited = true
      } else {
        warmSince = null
        coolSince ??= now
        if (now - coolSince >= 60_000) heatLimited = false
      }
    },
    stall(now: number) {
      stableSince = null
      stalls = stalls.filter((time) => now - time <= 30_000)
      stalls.push(now)
      if (stalls.length >= 2) networkLimited = true
    },
    playback(advancing: boolean, now: number) {
      if (!advancing) {
        stableSince = null
        return
      }
      stableSince ??= now
      if (now - stableSince >= 60_000) {
        networkLimited = false
        stalls = []
      }
    },
    resolution(preference: PlaybackQuality): PlaybackResolution {
      return heatLimited || networkLimited ? 480 : preference
    },
  }
}

/** Keep aspect ratio and support landscape imports as well as portrait capture. */
export function playbackSize(
  resolution: PlaybackResolution,
  size?: { width?: number; height?: number },
) {
  const width = size?.width ?? 0
  const height = size?.height ?? 0
  const ratio = width > 0 && height > 0 ? width / height : 9 / 16
  return ratio > 1
    ? { width: Math.ceil((resolution * ratio) / 2) * 2, height: resolution }
    : { width: resolution, height: Math.ceil(resolution / ratio / 2) * 2 }
}
