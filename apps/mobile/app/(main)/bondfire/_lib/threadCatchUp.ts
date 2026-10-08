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
  /** Identities, not positions: live queries can remove or insert earlier videos. */
  foldedVideoKeys: string[]
  newVideoKeys: string[]
}

// Folding a single video would swap one row for another of the same height.
export const MIN_FOLDED_VIDEOS = 2

type CatchUpVideo = { key: string; watchedByViewer: boolean }

/** Snapshot the arrival before playback changes the watched flags. */
export function getThreadCatchUp(videos: CatchUpVideo[], startIndex: number): ThreadCatchUp {
  const autoOpen = videos.some((video, index) => !video.watchedByViewer && index !== startIndex)
  const firstUnwatched = videos.findIndex((video) => !video.watchedByViewer)
  // Never fold the video a push lands on, even if it is already watched.
  const boundary = Math.min(firstUnwatched, startIndex)
  return {
    autoOpen,
    foldedVideoKeys:
      autoOpen && boundary >= MIN_FOLDED_VIDEOS
        ? videos.slice(0, boundary).map((video) => video.key)
        : [],
    newVideoKeys: videos.filter((video) => !video.watchedByViewer).map((video) => video.key),
  }
}

/** Only surviving arrival-folded videos at the head may be hidden. */
export function getThreadFoldedCount(videoKeys: string[], catchUp: ThreadCatchUp | null): number {
  const foldedKeys = new Set(catchUp?.foldedVideoKeys)
  const boundary = videoKeys.findIndex((key) => !foldedKeys.has(key))
  const count = boundary === -1 ? videoKeys.length : boundary
  return count >= MIN_FOLDED_VIDEOS ? count : 0
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
  const foldedCount = getThreadFoldedCount(videoKeys, catchUp)
  const newKeys = new Set(catchUp?.newVideoKeys)
  const firstNewIndex = videoKeys.findIndex((key) => newKeys.has(key))
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
    if (foldedCount > 0 && index === firstNewIndex) {
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
