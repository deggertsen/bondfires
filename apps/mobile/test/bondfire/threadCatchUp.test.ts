import { describe, expect, it } from 'vitest'
import {
  buildThreadBrowserLayout,
  getThreadFoldedCount,
  getThreadCatchUp as snapshotCatchUp,
  THREAD_SECTION_HEIGHTS,
} from '../../app/(main)/bondfire/_lib/threadCatchUp'

const ROW = 68
const KEYS = ['main', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']
// Watched the first three, four new: the thread from the mockups.
const CABIN = [true, true, true, false, false, false, false]
const getThreadCatchUp = (watched: boolean[], startIndex: number) =>
  snapshotCatchUp(
    watched.map((watchedByViewer, index) => ({ key: KEYS[index], watchedByViewer })),
    startIndex,
  )

describe('getThreadCatchUp', () => {
  it('opens on a normal arrival with two or more unwatched videos', () => {
    expect(getThreadCatchUp(CABIN, 3)).toEqual({
      autoOpen: true,
      foldedVideoKeys: KEYS.slice(0, 3),
      newVideoKeys: KEYS.slice(3),
    })
  })

  it('opens when a push lands past other unwatched videos', () => {
    expect(getThreadCatchUp(CABIN, 6)).toEqual({
      autoOpen: true,
      foldedVideoKeys: KEYS.slice(0, 3),
      newVideoKeys: KEYS.slice(3),
    })
  })

  it('stays closed when the only unwatched video is the one playing', () => {
    expect(getThreadCatchUp([true, true, false], 2)).toEqual({
      autoOpen: false,
      foldedVideoKeys: [],
      newVideoKeys: [KEYS[2]],
    })
    expect(getThreadCatchUp([true, true, true], 2).autoOpen).toBe(false)
  })

  it('opens when a push lands on a watched video while others are unwatched', () => {
    expect(getThreadCatchUp([true, true, true, true, false], 3)).toEqual({
      autoOpen: true,
      foldedVideoKeys: KEYS.slice(0, 3),
      newVideoKeys: [KEYS[4]],
    })
  })

  it('never folds the video that is playing', () => {
    expect(getThreadCatchUp([true, true, true, true, false, false], 1).foldedVideoKeys).toEqual([])
    expect(getThreadCatchUp([true, true, true, true, false, false], 2).foldedVideoKeys).toEqual(
      KEYS.slice(0, 2),
    )
  })

  it('does not fold a single watched video', () => {
    expect(getThreadCatchUp([true, false, false], 1)).toEqual({
      autoOpen: true,
      foldedVideoKeys: [],
      newVideoKeys: KEYS.slice(1, 3),
    })
  })
})

describe('buildThreadBrowserLayout', () => {
  it('lists every video when nothing is folded', () => {
    const { entries, videoOffsets } = buildThreadBrowserLayout({
      videoKeys: KEYS.slice(0, 3),
      rowHeight: ROW,
      catchUp: null,
      earlierExpanded: false,
    })
    expect(entries.map((entry) => entry.kind)).toEqual(['video', 'video', 'video'])
    expect(videoOffsets).toEqual([0, ROW, ROW * 2])
  })

  it('folds the watched head into one row above the new section', () => {
    const catchUp = getThreadCatchUp(CABIN, 6)
    const { entries, videoOffsets } = buildThreadBrowserLayout({
      videoKeys: KEYS,
      rowHeight: ROW,
      catchUp,
      earlierExpanded: false,
    })
    expect(entries.map((entry) => entry.kind)).toEqual([
      'earlier',
      'newLabel',
      'video',
      'video',
      'video',
      'video',
    ])
    const newStart = THREAD_SECTION_HEIGHTS.earlierRow + THREAD_SECTION_HEIGHTS.newLabel
    expect(videoOffsets).toEqual([
      undefined,
      undefined,
      undefined,
      newStart,
      newStart + ROW,
      newStart + ROW * 2,
      newStart + ROW * 3,
    ])
  })

  it('unfolds the watched videos in place under a header', () => {
    const catchUp = getThreadCatchUp(CABIN, 6)
    const { entries, videoOffsets } = buildThreadBrowserLayout({
      videoKeys: KEYS,
      rowHeight: ROW,
      catchUp,
      earlierExpanded: true,
    })
    expect(entries.map((entry) => entry.kind)).toEqual([
      'earlierHeader',
      'video',
      'video',
      'video',
      'newLabel',
      'video',
      'video',
      'video',
      'video',
    ])
    const header = THREAD_SECTION_HEIGHTS.earlierHeader
    expect(videoOffsets[0]).toBe(header)
    expect(videoOffsets[3]).toBe(header + ROW * 3 + THREAD_SECTION_HEIGHTS.newLabel)
    // Offsets are contiguous, so getItemLayout can trust them.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].offset).toBe(entries[i - 1].offset + entries[i - 1].height)
    }
  })
})

describe('catch-up across thread updates', () => {
  const catchUp = getThreadCatchUp(CABIN, 6)

  it('does not fold a new video after a watched video is removed', () => {
    const remaining = KEYS.filter((key) => key !== 'r1')
    const layout = buildThreadBrowserLayout({
      videoKeys: remaining,
      rowHeight: ROW,
      catchUp,
      earlierExpanded: false,
    })
    expect(getThreadFoldedCount(remaining, catchUp)).toBe(2)
    expect(layout.videoOffsets[remaining.indexOf('r3')]).toBeDefined()
    expect(layout.entries.filter((row) => row.kind === 'video').map((row) => row.key)).toEqual(
      KEYS.slice(3),
    )
  })

  it('stops folding when a newly playable video appears in the watched prefix', () => {
    const updated = [KEYS[0], 'newly-ready', ...KEYS.slice(1)]
    expect(getThreadFoldedCount(updated, catchUp)).toBe(0)
  })

  it('does not keep a one-video fold after removals', () => {
    expect(getThreadFoldedCount([KEYS[0], ...KEYS.slice(3)], catchUp)).toBe(0)
  })

  it('keeps the new section at the surviving arrival videos after one is removed', () => {
    const remaining = KEYS.filter((key) => key !== 'r3')
    const { entries } = buildThreadBrowserLayout({
      videoKeys: remaining,
      rowHeight: ROW,
      catchUp,
      earlierExpanded: false,
    })
    const label = entries.findIndex((entry) => entry.kind === 'newLabel')
    expect(entries[label + 1].key).toBe('r4')
  })
})
