import { useCallback, useEffect, useRef } from 'react'
import { AppState, Platform } from 'react-native'
import { telemetry } from '../services/telemetry'
import { livePublishActions, livePublishStore$ } from '../store/livePublish.store'
import { isNativePublisherStatus } from '../store/livePublisherContract'
import { uploadQueueStore$ } from '../store/uploadQueue.store'
import {
  createStallDetector,
  IOS_STALL_BITRATE_FLOOR_BPS,
  STALL_BITRATE_FLOOR_BPS,
  STATS_SAMPLE_INTERVAL_MS,
  type StallDetector,
} from '../utils/liveStallDetector'

/**
 * Default encoder settings. Keep in sync with the native option defaults
 * (LivePublisherStartOptions in BondfireLivePublisherModule.kt / .swift).
 * The thermal mitigation ladder in LiveRecordScreen restores these when the
 * device cools back down.
 */
export const LIVE_DEFAULT_VIDEO_BITRATE = 2_500_000
export const LIVE_DEFAULT_VIDEO_FPS = 30

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

// Keep in sync with LivePublisherStats in
// apps/mobile/modules/bondfire-live-publisher/index.ts and the getStats
// payloads in the Swift/Kotlin modules (livePublisherZeroStats / STATS_ZEROS).
export interface LivePublisherStats {
  bitrateBps: number
  rttMs: number
  droppedFrames: number
  /** Encoder output FPS (iOS only for now; 0 where unsupported). */
  currentFps?: number
  /**
   * 1 when bitrateBps is a real measurement (HaishinKit stream info on iOS,
   * TrafficStats TX delta on Android), 0/absent when it's a hard zero from a
   * platform or build that can't measure — those samples must not feed the
   * stall watchdog.
   */
  statsSupported?: number
  /** Mic route for the session: 'wired' | 'bluetooth' | 'builtin' (Android only for now). */
  audioRoute?: string
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
  /**
   * `level` is the normalized 0–3 mitigation scale shared across platforms
   * (nominal/fair/serious/critical). `rawLevel` (Android only) preserves the
   * unnormalized PowerManager status (0–6) for telemetry.
   */
  getThermalState?(): Promise<{ level: number; levelName: string; rawLevel?: number }>
  /** fps is applied on iOS only; Android adjusts bitrate dynamically and keeps fps fixed. */
  setVideoQuality?(videoBitrate: number, fps: number): Promise<void>
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

export interface LivePublisherStopResult {
  /** Whether Mux acknowledged the /complete signal that ends recording early. */
  completeSignaled: boolean | undefined
  /** False when Mux never reported the live stream active/watchable. */
  recordingStarted: boolean
  /** False when the backend was unreachable (e.g. offline) at stop time. */
  backendNotified: boolean
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
  // The ingest is tagged with the session it belongs to. Ownership
  // (hasProvisionedIngest) compares this against the module-global session so a
  // stale instance — one whose session was cancelled/replaced by another mounted
  // copy of the create screen — correctly reports that it no longer owns the
  // live session and stays out of the active instance's way.
  const ingestRef = useRef<{ rtmpsUrl: string; streamKey: string; sessionId: string } | null>(null)

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

      // Contract enforcement: native may only emit statuses from
      // NATIVE_PUBLISHER_STATUSES. Anything else is a native-side bug —
      // log loudly and ignore rather than corrupting the state machine.
      if (!isNativePublisherStatus(status)) {
        telemetry.error('live:contract', 'Native publisher emitted unknown status', {
          status,
          sessionId: livePublishStore$.sessionId.peek(),
        })
        return
      }

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

      livePublishActions.setStatus(status)

      // Log unexpected drops to telemetry for diagnosis. No user-facing
      // toast — the UI already handles the status transition silently.
      if (status === 'stream_stopped_unexpectedly' || status === 'endpoint_closed') {
        const startedAt = livePublishStore$.startedAt.peek()
        telemetry.info('live:unexpected_drop', 'Live stream stopped unexpectedly', {
          reason: status,
          sessionId: livePublishStore$.sessionId.peek(),
          recordId: livePublishStore$.recordId.peek(),
          durationMs: startedAt ? Date.now() - startedAt : undefined,
          lastBitrateBps: livePublishStore$.bitrateBps.peek(),
          everHadThroughput: livePublishStore$.everHadThroughput.peek(),
        })
      }
    })
    const errorSub = options.publisher.addListener('error', (error) => {
      // Memory warnings come through as error events with code 'memory_warning'.
      // These are telemetry-only — we do NOT want to fail the recording.
      if (error.code === 'memory_warning') {
        const status = livePublishStore$.status.peek()
        if (status === 'idle') return

        telemetry.warn('live:memory_warning', 'Memory pressure during recording', {
          message: error.message,
          sessionId: livePublishStore$.sessionId.peek(),
          recordId: livePublishStore$.recordId.peek(),
          status,
        })
        return
      }

      // Suppress errors that fire during/after teardown. The native streaming
      // libraries (StreamPack/HaishinKit) can emit internal errors as the
      // encoder, camera, and RTMP connection are being torn down — these are
      // teardown artifacts, not user-facing failures.
      const currentStatus = livePublishStore$.status.peek()
      const isTerminalOrTeardownStatus =
        currentStatus === 'stopping' ||
        currentStatus === 'ended' ||
        currentStatus === 'idle' ||
        currentStatus === 'endpoint_closed' ||
        currentStatus === 'stream_stopped_unexpectedly' ||
        currentStatus === 'errored'
      if (isTerminalOrTeardownStatus) {
        telemetry.warn(
          'live:crash_stale',
          'Live publisher native error after terminal transport state',
          {
            code: error.code,
            message: error.message,
            sessionId: livePublishStore$.sessionId.peek(),
            statusAtError: currentStatus,
          },
        )
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

  // Stall watchdog. Samples carrying statsSupported=1 are real measurements
  // (HaishinKit stream info on iOS, TrafficStats TX deltas on Android);
  // anything else is ignored so builds without real stats can never
  // false-positive. Detects both an encoder that stalls after healthy
  // throughput AND a pipeline that never produces a frame at all — production
  // telemetry shows the latter is the dominant camera-freeze failure mode.
  //
  // iOS measures the actual stream, so exact-zero semantics apply; Android
  // measures app-wide TX, so the 64kbps floor filters ambient traffic.
  const stallDetectorRef = useRef<StallDetector | null>(null)

  const startStatsSampling = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current)
    }
    if (!stallDetectorRef.current) {
      stallDetectorRef.current = createStallDetector(
        Platform.OS === 'android' ? STALL_BITRATE_FLOOR_BPS : IOS_STALL_BITRATE_FLOOR_BPS,
      )
    }
    const detector = stallDetectorRef.current
    detector.reset()
    livePublishActions.resetThroughput()

    // Prime the throughput baseline (Android's TrafficStats measurement needs
    // a first reading to diff against). Without this the first 5s tick is an
    // unmeasurable baseline and never-started detection slips from 20s to 25s
    // — inside Mux's idle-disconnect window.
    void options.publisher.getStats().catch(() => {})

    // Periodic stats breadcrumb counter — emit a stats snapshot every 30s
    // (6 stats samples at 5s interval) for crash timeline reconstruction.
    let statsBreadcrumbCounter = 0

    statsIntervalRef.current = setInterval(() => {
      // Ownership gate: when two create-screen copies are mounted (Spark tab +
      // pushed route), a stale instance whose session was replaced must not
      // write stats, arm the watchdog, or fail the active instance's session.
      const ingest = ingestRef.current
      if (!ingest || ingest.sessionId !== livePublishStore$.sessionId.peek()) {
        detector.idle()
        return
      }

      // Recording can't run in the background (both platforms suspend the
      // camera), and LiveRecordScreen owns backgrounding with its own grace
      // timer — a backgrounded tick must not read the paused encoder's zero
      // throughput as a stall.
      if (AppState.currentState !== 'active') {
        detector.idle()
        return
      }

      options.publisher
        .getStats()
        .then((stats) => {
          livePublishActions.setStats({
            bitrateBps: stats.bitrateBps,
            droppedFrames: stats.droppedFrames,
          })

          // Periodic breadcrumb — the first sample (5s in) then every ~30s,
          // logging a stats snapshot for crash timeline reconstruction. The
          // early first sample matters: most observed start-failures die
          // within 6–27s, before a 30s-only cadence would capture anything.
          // Keeps Convex load modest (2/min during recording) while giving us
          // a timeline if the app crashes.
          statsBreadcrumbCounter++
          if (statsBreadcrumbCounter === 1 || statsBreadcrumbCounter % 6 === 0) {
            const sessionId = livePublishStore$.sessionId.peek()
            const recordId = livePublishStore$.recordId.peek()
            const startedAt = livePublishStore$.startedAt.peek()
            telemetry.breadcrumb('live:stats_sample', {
              sessionId,
              recordId,
              bitrateBps: stats.bitrateBps,
              droppedFrames: stats.droppedFrames,
              currentFps: stats.currentFps,
              rttMs: stats.rttMs,
              statsSupported: stats.statsSupported,
              audioRoute: stats.audioRoute,
              elapsedMs: startedAt ? Date.now() - startedAt : undefined,
            })
            // Update crash-survivable breadcrumb with current state
            telemetry.setCrashBreadcrumb('live:recording', {
              sessionId,
              recordId,
              status: livePublishStore$.status.peek(),
              bitrateBps: stats.bitrateBps,
              droppedFrames: stats.droppedFrames,
              elapsedMs: startedAt ? Date.now() - startedAt : undefined,
            })
          }

          // Frozen-encoder watchdog: the connection poll catches dropped
          // sockets, but a pipeline that produces zero bytes while the socket
          // stays open emits no error event. Sustained ~zero throughput while
          // 'live' — whether the encoder stalled mid-stream or never delivered
          // a first frame — becomes an unexpected stop, so the UI recovers
          // instead of sitting on a frozen REC screen until Mux disconnects.
          if (livePublishStore$.status.peek() !== 'live') {
            detector.idle()
            return
          }

          // Android's TrafficStats measurement is app-wide: a concurrent
          // queue upload (record → upload → record again) reads as stream
          // throughput and would both mask a frozen pipeline and wrongly mark
          // everHadThroughput. Treat those samples as unmeasurable — the
          // duration heuristic and stop-time Mux truth still cover recovery.
          const uploadActive =
            Platform.OS === 'android' &&
            uploadQueueStore$.tasks
              .peek()
              .some((t) => t.status === 'uploading' || t.status === 'processing')

          const verdict = detector.sample({
            bitrateBps: stats.bitrateBps,
            statsSupported: stats.statsSupported === 1 && !uploadActive,
          })
          if (verdict.measured) {
            livePublishActions.noteThroughputSample(verdict.sawThroughput)
          }
          if (verdict.stalled) {
            telemetry.error('live:stall', 'Zero throughput while live — treating as stalled', {
              sessionId: livePublishStore$.sessionId.peek(),
              recordId: livePublishStore$.recordId.peek(),
              samples: verdict.samples,
              neverStarted: verdict.neverStarted,
            })
            livePublishActions.setStatus('stream_stopped_unexpectedly')
          }
        })
        .catch((error) => {
          telemetry.warn('live:stats', 'Failed to sample live publisher stats', {
            error: String(error),
          })
        })
    }, STATS_SAMPLE_INTERVAL_MS)
  }, [options.publisher])

  /**
   * Start the native camera preview only. No live stream is provisioned and
   * nothing is published — the camera output stays on-device.
   */
  const preview = useCallback(
    async (args: { initialCamera?: 'front' | 'back' } = {}) => {
      await options.publisher.startPreview({
        fps: LIVE_DEFAULT_VIDEO_FPS,
        videoBitrate: LIVE_DEFAULT_VIDEO_BITRATE,
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

        ingestRef.current = { ...liveStream.ingest, sessionId: liveStream.liveSessionId }
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
   * Whether this hook instance owns the *current* live session — i.e. it holds
   * ingest credentials AND they match the module-global session id.
   *
   * `ingestRef` lives only in this instance, so a freshly remounted screen
   * reports `false` until it provisions again (the orphaned-pre_connect signal).
   * The session-id match adds a second guarantee: when two copies of the create
   * screen are mounted at once (the Spark tab leaves one mounted while a pushed
   * route is focused), the instance whose session was cancelled/replaced by the
   * other reports `false` even though its `ingestRef` is still populated. That
   * keeps a stale duplicate from tearing down the active instance's recording —
   * the exact race behind mid-recording "Recording failed" and the
   * provision/cancel "Preparing camera…" loop.
   */
  const hasProvisionedIngest = useCallback(
    () =>
      ingestRef.current !== null &&
      ingestRef.current.sessionId === livePublishStore$.sessionId.peek(),
    [],
  )

  /**
   * Open the RTMP connection for a previously provisioned stream and start
   * publishing. This is the moment recording actually begins.
   */
  const connect = useCallback(
    async (args: { initialCamera?: 'front' | 'back' } = {}) => {
      const ingest = ingestRef.current
      if (!ingest || ingest.sessionId !== livePublishStore$.sessionId.peek()) {
        throw new Error('No provisioned live stream to connect')
      }

      try {
        telemetry.setCrashBreadcrumb('live:starting', {
          sessionId: livePublishStore$.sessionId.peek(),
          recordId: livePublishStore$.recordId.peek(),
          status: livePublishStore$.status.peek(),
        })
        await options.publisher.start({
          rtmpsUrl: ingest.rtmpsUrl,
          streamKey: ingest.streamKey,
          fps: LIVE_DEFAULT_VIDEO_FPS,
          videoBitrate: LIVE_DEFAULT_VIDEO_BITRATE,
          audioBitrate: 128_000,
          initialCamera: args.initialCamera ?? 'front',
        })
        startStatsSampling()
        telemetry.setCrashBreadcrumb('live:recording', {
          sessionId: livePublishStore$.sessionId.peek(),
          recordId: livePublishStore$.recordId.peek(),
          status: livePublishStore$.status.peek(),
        })
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
        ingestRef.current = { ...liveStream.ingest, sessionId: liveStream.liveSessionId }

        livePublishActions.start({
          sessionId: liveStream.liveSessionId,
          recordId: liveStream.recordId,
          liveStreamId: liveStream.liveStreamId,
          playbackId: liveStream.playbackId,
        })

        telemetry.setCrashBreadcrumb('live:starting', {
          sessionId: liveStream.liveSessionId,
          recordId: liveStream.recordId,
          status: livePublishStore$.status.peek(),
        })
        await options.publisher.start({
          rtmpsUrl: liveStream.ingest.rtmpsUrl,
          streamKey: liveStream.ingest.streamKey,
          fps: LIVE_DEFAULT_VIDEO_FPS,
          videoBitrate: LIVE_DEFAULT_VIDEO_BITRATE,
          audioBitrate: 128_000,
          initialCamera: args.initialCamera ?? 'front',
        })
        startStatsSampling()
        telemetry.setCrashBreadcrumb('live:recording', {
          sessionId: liveStream.liveSessionId,
          recordId: liveStream.recordId,
          status: livePublishStore$.status.peek(),
        })
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

  const stop = useCallback(async (): Promise<LivePublisherStopResult> => {
    const sessionId = livePublishStore$.sessionId.get()
    livePublishActions.setStatus('stopping')
    let publisherError: unknown
    let backendError: unknown

    let completeSignaled: boolean | undefined
    let recordingStarted = true
    const startedAt = livePublishStore$.startedAt.peek()

    // Crash context snapshot — write a breadcrumb right before the risky
    // native stop, where the Android double-teardown SIGSEGV can occur.
    telemetry.setCrashBreadcrumb('live:stopping', {
      sessionId,
      recordId: livePublishStore$.recordId.peek(),
      status: 'stopping',
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    })

    // Close native RTMP first. Waiting on the backend while StreamPack keeps
    // writing packets can crash in komuxer/DirectByteBuffer on Android; the
    // native publisher must leave the hot path as soon as the creator taps stop.
    try {
      await options.publisher.stop()
    } catch (error) {
      publisherError = error
    } finally {
      stopStatsSampling()
      ingestRef.current = null
      livePublishActions.setStatus('ended')
    }

    // Then have the backend finalize the recorded asset. Mux finalizes the VOD
    // on its own once our RTMP socket closes (above); endLiveStream confirms the
    // stream actually received media and marks the record processing. If the
    // stream never became active, it reports recordingStarted=false and the UI
    // offers a retry instead of showing a fake success screen.
    try {
      if (sessionId) {
        const result = await options.endLiveStream({
          liveSessionId: sessionId,
          reason: 'creator_stopped',
        })
        completeSignaled = readCompleteSignaled(result)
        recordingStarted = readRecordingStarted(result)
      }
    } catch (error) {
      backendError = error
    }

    telemetry.info('live:stop', 'Live publisher stopped', {
      sessionId,
      reason: publisherError ? 'error' : 'user_stopped',
      muxCompleteSignaled: completeSignaled,
      recordingStarted,
      publisherError: publisherError ? String(publisherError) : undefined,
      backendError: backendError ? String(backendError) : undefined,
    })

    // Clear the crash breadcrumb — stop completed (even if with errors), so
    // a subsequent app launch shouldn't report a crash-in-progress.
    telemetry.clearCrashBreadcrumb()

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

    // A backend error here is non-fatal. The native publisher has already
    // captured and flushed the recording to Mux, which finalizes the recorded
    // asset on RTMP disconnect even when we never reach the backend; the
    // asset.ready webhook then promotes the record to 'ready'. Surface whether
    // the backend was notified instead of throwing — throwing here used to dump
    // an offline creator back to an idle camera as if the recording was lost.
    return {
      completeSignaled,
      recordingStarted,
      backendNotified: !backendError,
    }
  }, [options, stopStatsSampling])

  const cancel = useCallback(async () => {
    const sessionId = livePublishStore$.sessionId.get()
    let publisherError: unknown
    let backendError: unknown

    telemetry.setCrashBreadcrumb('live:cancelling', {
      sessionId,
      recordId: livePublishStore$.recordId.peek(),
      status: 'stopping',
    })

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

    telemetry.clearCrashBreadcrumb()

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

  const setVideoQuality = useCallback(
    async (videoBitrate: number, fps: number) => {
      await options.publisher.setVideoQuality?.(videoBitrate, fps)
    },
    [options.publisher],
  )

  return {
    preview,
    provision,
    connect,
    start,
    stop,
    cancel,
    swapCamera,
    hasProvisionedIngest,
    setVideoQuality,
    stats$: livePublishStore$,
    getThermalState: options.publisher.getThermalState,
  }
}

function readCompleteSignaled(result: unknown): boolean | undefined {
  if (!result || typeof result !== 'object' || !('completeSignaled' in result)) {
    return undefined
  }

  const value = (result as { completeSignaled?: unknown }).completeSignaled
  return typeof value === 'boolean' ? value : undefined
}

function readRecordingStarted(result: unknown): boolean {
  if (!result || typeof result !== 'object' || !('recordingStarted' in result)) {
    return true
  }

  const value = (result as { recordingStarted?: unknown }).recordingStarted
  return typeof value === 'boolean' ? value : true
}
