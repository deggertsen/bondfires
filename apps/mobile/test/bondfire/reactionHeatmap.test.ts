import { describe, expect, it } from 'vitest'
import {
  buildReactionHeatmap,
  HEATMAP_BIN_COUNT,
  HEATMAP_MAX_PEAKS,
} from '../../app/(main)/bondfire/_lib/reactionHeatmap'

const at = (timestampMs: number, emoji = '🙏') => ({ emoji, timestampMs })

describe('buildReactionHeatmap', () => {
  it('draws nothing without reactions or a known duration', () => {
    expect(buildReactionHeatmap([], 60_000)).toBeNull()
    expect(buildReactionHeatmap(undefined, 60_000)).toBeNull()
    expect(buildReactionHeatmap([at(1000)], 0)).toBeNull()
    expect(buildReactionHeatmap([at(1000)], Number.NaN)).toBeNull()
  })

  it('normalizes smoothed bins so the densest bin is 1', () => {
    const heatmap = buildReactionHeatmap([at(5_000), at(5_200), at(40_000)], 60_000)
    expect(heatmap?.bins).toHaveLength(HEATMAP_BIN_COUNT)
    expect(Math.max(...(heatmap?.bins ?? []))).toBe(1)
    expect(Math.min(...(heatmap?.bins ?? []))).toBe(0)
  })

  it('places one marker per cluster with its top emoji, count and a 1s-early seek', () => {
    const heatmap = buildReactionHeatmap(
      [at(5_000), at(5_300, '❤️'), at(5_600), at(40_000, '❤️'), at(40_400, '❤️')],
      60_000,
    )
    expect(heatmap?.peaks).toEqual([
      expect.objectContaining({ emoji: '🙏', count: 3, firstTimestampMs: 5_000, seekMs: 4_000 }),
      expect.objectContaining({ emoji: '❤️', count: 2, firstTimestampMs: 40_000, seekMs: 39_000 }),
    ])
    expect(heatmap?.peaks[0].position).toBeCloseTo(5_300 / 60_000)
  })

  it('keeps markers at least 15% of the video apart and caps them at three', () => {
    const reactions = [2, 10, 30, 50, 70, 90].flatMap((second) => [
      at(second * 1000),
      at(second * 1000 + 100),
    ])
    const heatmap = buildReactionHeatmap(reactions, 100_000)
    const positions = heatmap?.peaks.map((peak) => peak.position) ?? []
    expect(positions.length).toBe(HEATMAP_MAX_PEAKS)
    for (let i = 1; i < positions.length; i++)
      expect(positions[i] - positions[i - 1]).toBeGreaterThanOrEqual(0.15)
  })

  it('never seeks before the start and clamps reactions past the end', () => {
    const heatmap = buildReactionHeatmap([at(300), at(70_000)], 60_000)
    expect(heatmap?.peaks[0].seekMs).toBe(0)
    expect(heatmap?.peaks.at(-1)?.firstTimestampMs).toBe(60_000)
  })
})
