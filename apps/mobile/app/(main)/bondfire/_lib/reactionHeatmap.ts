/**
 * Scrubber heatmap: where a video's reactions cluster, built from the
 * visibility-filtered reaction rows the player already loads (never from the
 * list summary, which can include reactors the viewer cannot see).
 */

export const HEATMAP_BIN_COUNT = 48
/** Peaks closer than this share of the video merge into one marker. */
export const HEATMAP_PEAK_SPACING = 0.15
export const HEATMAP_MAX_PEAKS = 3
/** Seeking to a marker starts this far before its first reaction. */
export const HEATMAP_SEEK_LEAD_MS = 1000

// Triangular smoothing kernel: a single reaction lights up a few bars, so the
// strip reads as density rather than isolated ticks.
const SMOOTHING_KERNEL = [1, 2, 3, 2, 1]

export type HeatmapReaction = { emoji: string; timestampMs: number }

export type HeatmapPeak = {
  /** Marker position along the bar, 0–1. */
  position: number
  /** Most common emoji in the peak; ties go to the one seen first. */
  emoji: string
  count: number
  firstTimestampMs: number
  seekMs: number
}

export type ReactionHeatmap = {
  /** Smoothed density per bin, normalized so the tallest bin is 1. */
  bins: number[]
  /** Up to HEATMAP_MAX_PEAKS markers, in playback order. */
  peaks: HeatmapPeak[]
}

function mostCommonEmoji(reactions: HeatmapReaction[]) {
  const counts = new Map<string, number>()
  let best = reactions[0]?.emoji ?? ''
  for (const reaction of reactions) {
    const count = (counts.get(reaction.emoji) ?? 0) + 1
    counts.set(reaction.emoji, count)
    if (count > (counts.get(best) ?? 0)) best = reaction.emoji
  }
  return best
}

/** Returns null when there is nothing to draw (no reactions or no known duration). */
export function buildReactionHeatmap(
  reactions: readonly HeatmapReaction[] | null | undefined,
  durationMs: number,
  binCount = HEATMAP_BIN_COUNT,
): ReactionHeatmap | null {
  if (!reactions?.length || !Number.isFinite(durationMs) || durationMs <= 0) return null

  const clamped = reactions.map((reaction) => ({
    emoji: reaction.emoji,
    timestampMs: Math.min(durationMs, Math.max(0, reaction.timestampMs)),
  }))

  const raw = new Array<number>(binCount).fill(0)
  for (const reaction of clamped) {
    const index = Math.min(binCount - 1, Math.floor((reaction.timestampMs / durationMs) * binCount))
    raw[index] += 1
  }

  const radius = Math.floor(SMOOTHING_KERNEL.length / 2)
  const smoothed = raw.map((_, index) =>
    SMOOTHING_KERNEL.reduce((sum, weight, offset) => {
      const source = index + offset - radius
      return source >= 0 && source < binCount ? sum + raw[source] * weight : sum
    }, 0),
  )
  const max = Math.max(...smoothed)
  const bins = smoothed.map((value) => (max > 0 ? value / max : 0))

  // Greedy peak pick: tallest bins first, skipping any too close to one already
  // chosen. Each peak then claims the reactions within half the spacing of it,
  // so neighboring markers never count the same reaction.
  const spacingBins = HEATMAP_PEAK_SPACING * binCount
  const peakBins: number[] = []
  const byHeight = smoothed
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index)
  for (const { index } of byHeight) {
    if (peakBins.length >= HEATMAP_MAX_PEAKS) break
    if (peakBins.every((picked) => Math.abs(picked - index) >= spacingBins)) peakBins.push(index)
  }

  const halfWindowMs = (HEATMAP_PEAK_SPACING / 2) * durationMs
  const peaks = peakBins.flatMap((index): HeatmapPeak[] => {
    const centerMs = ((index + 0.5) / binCount) * durationMs
    const inWindow = clamped.filter(
      (reaction) => Math.abs(reaction.timestampMs - centerMs) < halfWindowMs,
    )
    if (inWindow.length === 0) return []
    const firstTimestampMs = Math.min(...inWindow.map((reaction) => reaction.timestampMs))
    const meanMs =
      inWindow.reduce((sum, reaction) => sum + reaction.timestampMs, 0) / inWindow.length
    return [
      {
        position: meanMs / durationMs,
        emoji: mostCommonEmoji(inWindow),
        count: inWindow.length,
        firstTimestampMs,
        seekMs: Math.max(0, firstTimestampMs - HEATMAP_SEEK_LEAD_MS),
      },
    ]
  })

  return { bins, peaks: peaks.sort((a, b) => a.position - b.position) }
}
