import { observable } from '@legendapp/state'

export type LivePublishStatus =
  | 'idle'
  | 'creating'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'stopping'
  | 'ended'
  | 'errored'

export interface LivePublishState {
  sessionId: string | null
  recordId: string | null
  liveStreamId: string | null
  playbackId: string | null
  status: LivePublishStatus
  startedAt: number | null
  bitrateBps: number
  droppedFrames: number
  networkQuality: 'good' | 'fair' | 'poor' | 'unknown'
  errorMessage: string | null
}

const defaultLivePublishState: LivePublishState = {
  sessionId: null,
  recordId: null,
  liveStreamId: null,
  playbackId: null,
  status: 'idle',
  startedAt: null,
  bitrateBps: 0,
  droppedFrames: 0,
  networkQuality: 'unknown',
  errorMessage: null,
}

export const livePublishStore$ = observable<LivePublishState>(defaultLivePublishState)

export const livePublishActions = {
  beginCreate: () => {
    livePublishStore$.set({
      ...defaultLivePublishState,
      status: 'creating',
    })
  },

  start: (session: {
    sessionId: string
    recordId: string
    liveStreamId: string
    playbackId?: string | null
  }) => {
    livePublishStore$.set({
      ...defaultLivePublishState,
      sessionId: session.sessionId,
      recordId: session.recordId,
      liveStreamId: session.liveStreamId,
      playbackId: session.playbackId ?? null,
      status: 'connecting',
      startedAt: Date.now(),
    })
  },

  setStatus: (status: LivePublishStatus) => {
    livePublishStore$.status.set(status)
    if (status === 'live' && !livePublishStore$.startedAt.get()) {
      livePublishStore$.startedAt.set(Date.now())
    }
  },

  setStats: (stats: { bitrateBps: number; droppedFrames: number }) => {
    livePublishStore$.bitrateBps.set(stats.bitrateBps)
    livePublishStore$.droppedFrames.set(stats.droppedFrames)
    livePublishStore$.networkQuality.set(classifyNetworkQuality(stats))
  },

  fail: (error: unknown) => {
    livePublishStore$.status.set('errored')
    livePublishStore$.errorMessage.set(error instanceof Error ? error.message : String(error))
  },

  reset: () => {
    livePublishStore$.set(defaultLivePublishState)
  },
}

function classifyNetworkQuality(stats: { bitrateBps: number; droppedFrames: number }) {
  if (stats.bitrateBps <= 0) {
    return 'unknown'
  }

  if (stats.bitrateBps < 900_000 || stats.droppedFrames > 30) {
    return 'poor'
  }

  if (stats.bitrateBps < 1_800_000 || stats.droppedFrames > 10) {
    return 'fair'
  }

  return 'good'
}
