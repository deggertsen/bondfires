import { useCallback, useEffect, useRef } from 'react'
import { telemetry } from '../services/telemetry'
import {
  type LivePublishStatus,
  livePublishActions,
  livePublishStore$,
} from '../store/livePublish.store'

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
  /** Encoder output FPS (iOS only for now; 0 where unsupported). */
  currentFps?: number
}

export interface LivePublisherSubscription {
  remove: () => void
}

export interface LivePublisherPreviewOptions {
  fps?: number
  videoBitrate?: number
  audioBitrate?: number
  initialCamera?: 'front' | 'back'
}

export interface LivePublisherNativeModule {
  isAvailable?: () => Promise<boolean>
  startPreview(options: LivePublisherPreviewOptions): Promise<void>
  start(options: LivePublisherStartOptions): Promise<void>
  stop(): Promise<void>
  swapCamera(): Promise<void>
  setMuted(muted: boolean): Promise<void>
  getStats(): Promise<LivePublisherStats>
  addListener(event: 'statusChange', cb: (status: string) => void): LivePublisherSubscription
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
    personalCamp?: boolean
    tags?: string[]
    width?: number
    height?: number
    title?: string
    pending?: boolean
  }) => Promise<CreateLiveStreamResult>
  endLiveStream: (args: { liveSessionId: string; reason?: string }) => Promise<unknown>
  cancelLiveStream: (args: { liveSessionId: string; reason?: string }) => Promise<unknown>
}) {
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const ingestRef = useRef<{ rtmpsUrl: string; streamKey: string } | null>(null)

  const stopStatsSampling = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current)
      statsIntervalRef.current = null
    }
  }, [])

  useEffect(() => {
    const statusSub = options.publisher.addListener('statusChange', (rawStatus) => {
      // Native emits { status: "..." } from sendStatus helper, but could
      // also emit a plain string. Normalize to a string.
      const status: string =
        typeof rawStatus === 'string'
          ? rawStatus
          : (((rawStatus as Record<string, unknown>)?.status as string) ?? 'unknown')

      // Suppress spurious events during intentional stop — the collectors
      // for isStreamingFlow / isOpenFlow fire before the explicit "ended",
      // but the native module now guards with isStoppingIntentionally.
      // This is a belt-and-suspenders check on the JS side.
      if (status === 'stream_stopped_unexpectedly' || status === 'endpoint_closed') {
        const currentStatus = livePublishStore$.status.peek()
        if (currentStatus === 'stopping' || currentStatus === 'ended' || currentStatus === 'idle') {
          return // intentional stop in progress, ignore
        }
      }

      livePublishActions.setStatus((status === 'ended' ? 'ended' : status) as LivePublishStatus)

      // Log unexpected drops to telemetry for diagnosis. No user-facing
      // toast — the UI already handles the status transition silently.
      if (status === 'stream_stopped_unexpectedly' || status === 'endpoint_closed') {
        const startedAt = livePublishStore$.startedAt.peek()
        telemetry.info('live:unexpected_drop', 'Live stream stopped unexpectedly', {
          reason: status,
          sessionId: livePublishStore$.sessionId.peek(),
          recordId: livePublishStore$.recordId.peek(),
          durationMs: startedAt ? Date.now() - startedAt : undefined,
        })
      }
    })
    const errorSub = options.publisher.addListener('error', (error) => {
      // Suppress errors that fire during/after teardown. The native streaming
      // libraries (StreamPack/HaishinKit) can emit internal errors as the
      // encoder, camera, and RTMP connection are being torn down — these are
      // teardown artifacts, not user-facing failures.
      const currentStatus = livePublishStore$.status.peek()
      if (currentStatus === 'stopping' || currentStatus === 'ended' || currentStatus === 'idle') {
        telemetry.warn('live:crash_stale', 'Live publisher native error (teardown artifact)', {
          code: error.code,
          message: error.message,
          sessionId: livePublishStore$.sessionId.peek(),
          statusAtError: currentStatus,
        })
        return
      }

      telemetry.error('live:crash', 'Live publisher native error', {
        code: error.code,
        message: error.message,
        sessionId: livePublishStore$.sessionId.peek(),
      })
      livePublishActions.fail(new Error(error.message))
    })

    return () => {
      statusSub.remove()
      errorSub.remove()
      stopStatsSampling()
    }
  }, [options.publisher, stopStatsSampling])

  // Stall watchdog state. Only armed after at least one nonzero throughput
  // sample, so platforms whose getStats returns hard zeros (no real stats)
  // can never false-positive.
  const sawThroughputRef = useRef(false)
  const zeroThroughputSamplesRef = useRef(0)
  const STALL_SAMPLE_LIMIT = 3 // 3 × 5s sampling = ~15s of silence

  const startStatsSampling = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current)
    }
    sawThroughputRef.current = false
    zeroThroughputSamplesRef.current = 0

    statsIntervalRef.current = setInterval(() => {
      options.publisher
        .getStats()
        .then((stats) => {
          livePublishActions.setStats({
            bitrateBps: stats.bitrateBps,
            droppedFrames: stats.droppedFrames,
          })

          // Frozen-encoder watchdog: the connection poll catches dropped
          // sockets, but an encoder that stalls while the socket stays open
          // produces zero bytes with no error event. Treat sustained zero
          // throughput (after proven-live throughput) as an unexpected stop —
          // the UI then finalizes the partial recording instead of sitting
          // on a frozen REC screen.
          if (livePublishStore$.status.peek() !== 'live') {
            zeroThroughputSamplesRef.current = 0
            return
          }

          if (stats.bitrateBps > 0) {
            sawThroughputRef.current = true
            zeroThroughputSamplesRef.current = 0
            return
          }

          if (!sawThroughputRef.current) {
            return
          }

          zeroThroughputSamplesRef.current += 1
          if (zeroThroughputSamplesRef.current >= STALL_SAMPLE_LIMIT) {
            zeroThroughputSamplesRef.current = 0
            telemetry.error('live:stall', 'Zero throughput while live — treating as stalled', {
              sessionId: livePublishStore$.sessionId.peek(),
              recordId: livePublishStore$.recordId.peek(),
              samples: STALL_SAMPLE_LIMIT,
            })
            livePublishActions.setStatus('stream_stopped_unexpectedly')
          }
        })
        .catch((error) => {
          telemetry.warn('live:stats', 'Failed to sample live publisher stats', {
            error: String(error),
          })
        })
    }, 5000)
  }, [options.publisher])

  /**
   * Start the native camera preview only. No live stream is provisioned and
   * nothing is published — the camera output stays on-device.
   */
  const preview = useCallback(
    async (args: { initialCamera?: 'front' | 'back' } = {}) => {
      await options.publisher.startPreview({
        fps: 30,
        videoBitrate: 2_500_000,
        audioBitrate: 128_000,
        initialCamera: args.initialCamera ?? 'front',
      })
    },
    [options.publisher],
  )

  /**
   * Provision the Mux live stream + record row without publishing.
   * Stores the ingest credentials for a later connect().
   */
  const provision = useCallback(
    async (
      args: {
        respondToBondfireId?: string
        campId?: string
        personalCamp?: boolean
        tags?: string[]
        title?: string
        pending?: boolean
      } = {},
    ) => {
      telemetry.info('live:provision', 'Live stream provisioning requested', {
        isResponse: !!args.respondToBondfireId,
        hasCampId: !!args.campId,
        isPersonalCamp: !!args.personalCamp,
      })

      livePublishActions.beginCreate()
      let provisionedSessionId: string | null = null
      try {
        const liveStream = await options.createLiveStream({
          isResponse: !!args.respondToBondfireId,
          bondfireId: args.respondToBondfireId,
          campId: args.campId,
          personalCamp: args.personalCamp,
          tags: args.tags,
          title: args.title,
          pending: args.pending,
        })
        provisionedSessionId = liveStream.liveSessionId

        ingestRef.current = liveStream.ingest
        livePublishActions.provisioned({
          sessionId: liveStream.liveSessionId,
          recordId: liveStream.recordId,
          liveStreamId: liveStream.liveStreamId,
          playbackId: liveStream.playbackId,
        })

        return liveStream
      } catch (error) {
        livePublishActions.fail(error)
        // Roll back the Mux live stream we provisioned so we don't keep paying
        // for an orphaned session. This mirrors the same safeguard in start().
        if (provisionedSessionId) {
          try {
            await options.cancelLiveStream({
              liveSessionId: provisionedSessionId,
              reason: 'provision_failed',
            })
          } catch (cancelError) {
            telemetry.warn(
              'live:cancel',
              'Failed to cancel orphaned Mux live stream after provision error',
              {
                error: String(cancelError),
              },
            )
          }
        }
        throw error
      }
    },
    [options],
  )

  /**
   * Open the RTMP connection for a previously provisioned stream and start
   * publishing. This is the moment recording actually begins.
   */
  const connect = useCallback(
    async (args: { initialCamera?: 'front' | 'back' } = {}) => {
      const ingest = ingestRef.current
      if (!ingest) {
        throw new Error('No provisioned live stream to connect')
      }

      try {
        await options.publisher.start({
          rtmpsUrl: ingest.rtmpsUrl,
          streamKey: ingest.streamKey,
          fps: 30,
          videoBitrate: 2_500_000,
          audioBitrate: 128_000,
          initialCamera: args.initialCamera ?? 'front',
        })
        startStatsSampling()
        telemetry.info('live:start_success', 'Live publisher connected', {
          sessionId: livePublishStore$.sessionId.peek(),
          recordId: livePublishStore$.recordId.peek(),
        })
      } catch (error) {
        // Keep the provisioned session intact so the user can retry the tap;
        // status goes back to 'ready' rather than 'errored'.
        const errObj = error instanceof Error ? error : new Error(String(error))
        telemetry.error('live:start_failed', 'Live publisher connect failed', {
          errorMessage: errObj.message,
          errorName: errObj.name,
          sessionId: livePublishStore$.sessionId.peek(),
        })
        livePublishActions.setStatus('ready')
        throw error
      }
    },
    [options.publisher, startStatsSampling],
  )

  const start = useCallback(
    async (
      args: {
        respondToBondfireId?: string
        campId?: string
        personalCamp?: boolean
        tags?: string[]
        initialCamera?: 'front' | 'back'
        title?: string
        pending?: boolean
      } = {},
    ) => {
      telemetry.info('live:start', 'Live publisher start requested', {
        camera: args.initialCamera ?? 'unknown',
        isResponse: !!args.respondToBondfireId,
        hasCampId: !!args.campId,
        isPersonalCamp: !!args.personalCamp,
      })

      livePublishActions.beginCreate()
      let provisionedSessionId: string | null = null
      try {
        const liveStream = await options.createLiveStream({
          isResponse: !!args.respondToBondfireId,
          bondfireId: args.respondToBondfireId,
          campId: args.campId,
          personalCamp: args.personalCamp,
          tags: args.tags,
          title: args.title,
          pending: args.pending,
        })
        provisionedSessionId = liveStream.liveSessionId
        ingestRef.current = liveStream.ingest

        livePublishActions.start({
          sessionId: liveStream.liveSessionId,
          recordId: liveStream.recordId,
          liveStreamId: liveStream.liveStreamId,
          playbackId: liveStream.playbackId,
        })

        await options.publisher.start({
          rtmpsUrl: liveStream.ingest.rtmpsUrl,
          streamKey: liveStream.ingest.streamKey,
          fps: 30,
          videoBitrate: 2_500_000,
          audioBitrate: 128_000,
          initialCamera: args.initialCamera ?? 'front',
        })
        startStatsSampling()
        telemetry.info('live:start_success', 'Live publisher started successfully', {
          sessionId: liveStream.liveSessionId,
          recordId: liveStream.recordId,
          playbackId: liveStream.playbackId,
        })
      } catch (error) {
        const errObj = error instanceof Error ? error : new Error(String(error))
        telemetry.error('live:start_failed', 'Live publisher start failed', {
          errorMessage: errObj.message,
          errorName: errObj.name,
          code: (error as { code?: string })?.code,
          sessionId: provisionedSessionId,
          camera: args.initialCamera ?? 'unknown',
        })
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
            telemetry.warn('live:cancel', 'Failed to cancel orphaned Mux live stream', {
              error: String(cancelError),
            })
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

    // Ask Mux to finish the recorded asset before closing our RTMP publisher.
    // The /complete API ends recording immediately instead of waiting for the
    // reconnect window, while Mux keeps the encoder connection open briefly.
    let completeSignaled: boolean | undefined
    try {
      if (sessionId) {
        const result = await options.endLiveStream({
          liveSessionId: sessionId,
          reason: 'creator_stopped',
        })
        completeSignaled = readCompleteSignaled(result)
      }
    } catch (error) {
      backendError = error
    }

    try {
      await options.publisher.stop()
    } catch (error) {
      publisherError = error
    } finally {
      stopStatsSampling()
      ingestRef.current = null
      livePublishActions.setStatus('ended')
    }

    telemetry.info('live:stop', 'Live publisher stopped', {
      sessionId,
      reason: publisherError ? 'error' : 'user_stopped',
      muxCompleteSignaled: completeSignaled,
      publisherError: publisherError ? String(publisherError) : undefined,
      backendError: backendError ? String(backendError) : undefined,
    })

    if (publisherError) {
      if (backendError) {
        telemetry.warn(
          'live:end',
          'Failed to mark live stream ending after publisher stop failed',
          { error: String(backendError) },
        )
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
      ingestRef.current = null
      livePublishActions.reset()
    }

    telemetry.info('live:stop', 'Live publisher cancelled', {
      sessionId,
      reason: 'user_cancelled',
      publisherError: publisherError ? String(publisherError) : undefined,
    })

    if (publisherError) {
      if (backendError) {
        telemetry.warn('live:cancel', 'Failed to cancel live stream after publisher stop failed', {
          error: String(backendError),
        })
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
    preview,
    provision,
    connect,
    start,
    stop,
    cancel,
    swapCamera,
    stats$: livePublishStore$,
  }
}

function readCompleteSignaled(result: unknown): boolean | undefined {
  if (!result || typeof result !== 'object' || !('completeSignaled' in result)) {
    return undefined
  }

  const value = (result as { completeSignaled?: unknown }).completeSignaled
  return typeof value === 'boolean' ? value : undefined
}
