import { useCallback, useEffect, useRef } from 'react'
import { livePublishActions, livePublishStore$ } from '../store/livePublish.store'

export interface LivePublisherStartOptions {
  rtmpsUrl: string
  streamKey: string
  width?: number
  height?: number
  fps?: number
  videoBitrate?: number
  audioBitrate?: number
  initialCamera?: 'front' | 'back'
}

export interface LivePublisherStats {
  bitrateBps: number
  rttMs: number
  droppedFrames: number
}

export interface LivePublisherSubscription {
  remove: () => void
}

export interface LivePublisherNativeModule {
  isAvailable?: () => Promise<boolean>
  start(options: LivePublisherStartOptions): Promise<void>
  stop(): Promise<void>
  swapCamera(): Promise<void>
  setMuted(muted: boolean): Promise<void>
  getStats(): Promise<LivePublisherStats>
  addListener(
    event: 'statusChange',
    cb: (status: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'errored' | 'ended') => void,
  ): LivePublisherSubscription
  addListener(
    event: 'error',
    cb: (error: { code: string; message: string }) => void,
  ): LivePublisherSubscription
}

export interface CreateLiveStreamResult {
  liveStreamId: string
  liveSessionId: string
  playbackId?: string
  ingest: {
    rtmpsUrl: string
    streamKey: string
  }
  recordId: string
  recordType: 'bondfire' | 'response'
}

export function useLivePublisher(options: {
  publisher: LivePublisherNativeModule
  createLiveStream: (args: {
    isResponse: boolean
    bondfireId?: string
    campId?: string
    tags?: string[]
    width?: number
    height?: number
  }) => Promise<CreateLiveStreamResult>
  endLiveStream: (args: { liveSessionId: string; reason?: string }) => Promise<unknown>
  cancelLiveStream: (args: { liveSessionId: string; reason?: string }) => Promise<unknown>
}) {
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopStatsSampling = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current)
      statsIntervalRef.current = null
    }
  }, [])

  useEffect(() => {
    const statusSub = options.publisher.addListener('statusChange', (status) => {
      livePublishActions.setStatus(status === 'ended' ? 'ended' : status)
    })
    const errorSub = options.publisher.addListener('error', (error) => {
      livePublishActions.fail(new Error(error.message))
    })

    return () => {
      statusSub.remove()
      errorSub.remove()
      stopStatsSampling()
    }
  }, [options.publisher, stopStatsSampling])

  const startStatsSampling = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current)
    }

    statsIntervalRef.current = setInterval(() => {
      options.publisher
        .getStats()
        .then((stats) => {
          livePublishActions.setStats({
            bitrateBps: stats.bitrateBps,
            droppedFrames: stats.droppedFrames,
          })
        })
        .catch((error) => {
          console.warn('Failed to sample live publisher stats:', error)
        })
    }, 5000)
  }, [options.publisher])

  const start = useCallback(
    async (
      args: {
        respondToBondfireId?: string
        campId?: string
        tags?: string[]
        initialCamera?: 'front' | 'back'
      } = {},
    ) => {
      livePublishActions.beginCreate()
      let provisionedSessionId: string | null = null
      try {
        const liveStream = await options.createLiveStream({
          isResponse: !!args.respondToBondfireId,
          bondfireId: args.respondToBondfireId,
          campId: args.campId,
          tags: args.tags,
          width: 720,
          height: 1280,
        })
        provisionedSessionId = liveStream.liveSessionId

        livePublishActions.start({
          sessionId: liveStream.liveSessionId,
          recordId: liveStream.recordId,
          liveStreamId: liveStream.liveStreamId,
          playbackId: liveStream.playbackId,
        })

        await options.publisher.start({
          rtmpsUrl: liveStream.ingest.rtmpsUrl,
          streamKey: liveStream.ingest.streamKey,
          width: 720,
          height: 1280,
          fps: 30,
          videoBitrate: 2_500_000,
          audioBitrate: 128_000,
          initialCamera: args.initialCamera ?? 'front',
        })
        startStatsSampling()
      } catch (error) {
        livePublishActions.fail(error)
        // Roll back the Mux live stream we provisioned so we don't keep paying
        // for an orphaned session that no client will ever publish to.
        if (provisionedSessionId) {
          try {
            await options.cancelLiveStream({
              liveSessionId: provisionedSessionId,
              reason: 'publisher_start_failed',
            })
          } catch (cancelError) {
            console.warn('Failed to cancel orphaned Mux live stream:', cancelError)
          }
        }
        throw error
      }
    },
    [options, startStatsSampling],
  )

  const stop = useCallback(async () => {
    const sessionId = livePublishStore$.sessionId.get()
    livePublishActions.setStatus('stopping')
    let publisherError: unknown
    let backendError: unknown

    try {
      await options.publisher.stop()
    } catch (error) {
      publisherError = error
    }

    try {
      if (sessionId) {
        await options.endLiveStream({ liveSessionId: sessionId, reason: 'creator_stopped' })
      }
    } catch (error) {
      backendError = error
    } finally {
      stopStatsSampling()
      livePublishActions.setStatus('ended')
    }

    if (publisherError) {
      if (backendError) {
        console.warn('Failed to mark live stream ending after publisher stop failed:', backendError)
      }
      throw publisherError
    }

    if (backendError) {
      throw backendError
    }
  }, [options, stopStatsSampling])

  const cancel = useCallback(async () => {
    const sessionId = livePublishStore$.sessionId.get()
    let publisherError: unknown
    let backendError: unknown

    try {
      await options.publisher.stop()
    } catch (error) {
      publisherError = error
    }

    try {
      if (sessionId) {
        await options.cancelLiveStream({ liveSessionId: sessionId, reason: 'creator_cancelled' })
      }
    } catch (error) {
      backendError = error
    } finally {
      stopStatsSampling()
      livePublishActions.reset()
    }

    if (publisherError) {
      if (backendError) {
        console.warn('Failed to cancel live stream after publisher stop failed:', backendError)
      }
      throw publisherError
    }

    if (backendError) {
      throw backendError
    }
  }, [options, stopStatsSampling])

  const swapCamera = useCallback(async () => {
    await options.publisher.swapCamera()
  }, [options.publisher])

  return {
    start,
    stop,
    cancel,
    swapCamera,
    stats$: livePublishStore$,
  }
}
