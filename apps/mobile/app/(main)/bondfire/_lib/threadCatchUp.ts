/**
 * Arrival catch-up for the thread browser. When a bondfire opens and something
 * unwatched is not the video that starts playing, the browser opens on its own
 * with the already-watched head of the thread folded into one row, so the
 * viewer can see what is new and where they are in it.
 *
 * Taken once per arrival from the watched flags as they were on open: a video
 * turns watched as soon as the viewer finishes it, so the live flags stop
 * describing what was new when the viewer arrived.
 */
export type ThreadCatchUp = {
  /** Open the browser on arrival. */
  autoOpen: boolean
  /** Leading videos folded into one "earlier" row; 0 means nothing is folded. */
  foldedCount: number
  /** Label the first unfolded video as the start of what's new. */
  showsNewLabel: boolean
}

// Folding a single video would swap one row for another of the same height.
export const MIN_FOLDED_VIDEOS = 2

const NO_CATCH_UP: ThreadCatchUp = { autoOpen: false, foldedCount: 0, showsNewLabel: false }

/**
 * `watched` is in thread order (main video first); `startIndex` is the video
 * the viewer lands on — the first unwatched one, or a push's video.
 */
export function getThreadCatchUp(watched: boolean[], startIndex: number): ThreadCatchUp {
  const autoOpen = watched.some((isWatched, index) => !isWatched && index !== startIndex)
  if (!autoOpen) return NO_CATCH_UP

  // Fold the watched run before the first unwatched video, but never past the
  // video that's playing (a push can land on an already-watched video).
  const firstUnwatched = watched.indexOf(false)
  const boundary = Math.min(firstUnwatched, startIndex)
  const foldedCount = boundary >= MIN_FOLDED_VIDEOS ? boundary : 0

  return {
    autoOpen,
    foldedCount,
    showsNewLabel: foldedCount > 0 && !watched[foldedCount],
  }
}

export const THREAD_SECTION_HEIGHTS = {
  earlierRow: 54,
  earlierHeader: 32,
  newLabel: 28,
} as const

type ThreadBrowserRow =
  | { kind: 'earlier'; key: 'earlier' }
  | { kind: 'earlierHeader'; key: 'earlier' }
  | { kind: 'newLabel'; key: 'new-label' }
  | { kind: 'video'; key: string; index: number }

export type ThreadBrowserEntry = ThreadBrowserRow & { offset: number; height: number }

/**
 * Rows for the browser's list with their offsets, so scrolling to the playing
 * video stays a lookup even with the fold and section label mixed in.
 * `videoOffsets[i]` is undefined while video i is folded away.
 */
export function buildThreadBrowserLayout({
  videoKeys,
  rowHeight,
  catchUp,
  earlierExpanded,
}: {
  videoKeys: string[]
  rowHeight: number
  catchUp: ThreadCatchUp | null
  earlierExpanded: boolean
}) {
  const foldedCount = catchUp?.foldedCount ?? 0
  const entries: ThreadBrowserEntry[] = []
  const videoOffsets: (number | undefined)[] = []
  let offset = 0

  const push = (row: ThreadBrowserRow, height: number) => {
    entries.push({ ...row, offset, height })
    offset += height
  }

  if (foldedCount > 0) {
    if (earlierExpanded) {
      push({ kind: 'earlierHeader', key: 'earlier' }, THREAD_SECTION_HEIGHTS.earlierHeader)
    } else {
      push({ kind: 'earlier', key: 'earlier' }, THREAD_SECTION_HEIGHTS.earlierRow)
    }
  }

  videoKeys.forEach((key, index) => {
    if (index === foldedCount && catchUp?.showsNewLabel) {
      push({ kind: 'newLabel', key: 'new-label' }, THREAD_SECTION_HEIGHTS.newLabel)
    }
    if (index < foldedCount && !earlierExpanded) {
      videoOffsets.push(undefined)
      return
    }
    videoOffsets.push(offset)
    push({ kind: 'video', key, index }, rowHeight)
  })

  return { entries, videoOffsets }
}
