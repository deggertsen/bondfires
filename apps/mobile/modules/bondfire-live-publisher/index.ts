import {
  EventEmitter,
  NativeModulesProxy,
  requireNativeModule,
  requireNativeViewManager,
} from 'expo-modules-core'
import type { ComponentType } from 'react'
import { View, type ViewProps } from 'react-native'

export interface LivePublisherStartOptions {
  rtmpsUrl: string
  streamKey: string
  width?: number
  height?: number
  fps?: number
  videoBitrate?: number
  audioBitrate?: number
  initialCamera?: 'front' | 'back'
  /**
   * Non-empty arms the native local MP4 backup recorder, writing the session
   * to <documents>/recordings/<localBackupFileName> alongside the RTMP
   * stream. Empty/absent disables the backup (the default).
   */
  localBackupFileName?: string
}

export interface LivePublisherStartResult {
  /** True only when native confirmed that the local file sink is recording. */
  localBackupArmed: boolean
}

export interface LivePublisherPreviewOptions {
  fps?: number
  videoBitrate?: number
  audioBitrate?: number
  initialCamera?: 'front' | 'back'
}

// Keep in sync with LivePublisherStats in
// packages/app/src/hooks/useLivePublisher.ts and the getStats payloads in the
// Swift/Kotlin modules (livePublisherZeroStats / STATS_ZEROS).
export interface LivePublisherStats {
  bitrateBps: number
  rttMs: number
  droppedFrames: number
  /** Encoder output FPS (iOS only for now; 0 where unsupported). */
  currentFps?: number
  /** 1 when bitrateBps is a real measurement, 0 when it's a hard zero. */
  statsSupported?: number
  /** Mic route for the session: 'wired' | 'bluetooth' | 'builtin' (Android only for now). */
  audioRoute?: string
}

export interface LivePublisherVideoQualityResult {
  /** Native-side configuration after the update completed. */
  configuredVideoBitrate: number
  configuredFps: number
  /** Android currently keeps the encoder/camera FPS fixed during a live stream. */
  fpsChangeSupported: boolean
}

export interface LivePublisherViewProps extends ViewProps {}

// Keep in sync with NATIVE_PUBLISHER_STATUSES in
// packages/app/src/store/livePublisherContract.ts and the PublisherStatus
// enums in the Swift/Kotlin modules (see README.md).
type Status =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'ended'
  | 'errored'
  | 'stream_stopped_unexpectedly'
  | 'endpoint_closed'
type StatusEvent = Status | { status?: Status }
type ErrorEvent = {
  code: string
  message: string
  /** iOS AVCaptureSession interruption reason, when available. */
  reason?: number
  /** Monotonic interruption duration reported by native iOS. */
  elapsedMs?: number
}
type EventSubscription = { remove: () => void }

interface NativeLivePublisher {
  isAvailable?: () => Promise<boolean>
  getCameraCount?: () => Promise<number>
  startPreview?: (options: LivePublisherPreviewOptions) => Promise<void>
  start(options: LivePublisherStartOptions): Promise<LivePublisherStartResult>
  stop(): Promise<void>
  swapCamera(): Promise<void>
  setMuted(muted: boolean): Promise<void>
  setVideoQuality(videoBitrate: number, fps: number): Promise<LivePublisherVideoQualityResult>
  getStats(): Promise<LivePublisherStats>
  getThermalState?(): Promise<{ level: number; levelName: string }>
}

function loadNativeModule(): NativeLivePublisher {
  try {
    return requireNativeModule<NativeLivePublisher>('BondfireLivePublisher')
  } catch {
    return NativeModulesProxy.BondfireLivePublisher as NativeLivePublisher
  }
}

const nativeModule = loadNativeModule()
const emitter = nativeModule ? new EventEmitter(nativeModule as never) : null

function unavailablePromise(): Promise<never> {
  return Promise.reject(
    new Error('BondfireLivePublisher is unavailable. Create a new development build first.'),
  )
}

function loadView(): ComponentType<LivePublisherViewProps> {
  try {
    return requireNativeViewManager('BondfireLivePublisher')
  } catch {
    return View
  }
}

export const LivePublisherView = loadView()

type AddListener = {
  (event: 'statusChange', cb: (status: Status) => void): EventSubscription
  (event: 'error', cb: (error: ErrorEvent) => void): EventSubscription
}

const addListener: AddListener = (
  event: 'statusChange' | 'error',
  cb: ((status: Status) => void) | ((error: ErrorEvent) => void),
): EventSubscription => {
  if (!emitter) {
    return { remove: () => {} }
  }

  if (event === 'statusChange') {
    return emitter.addListener(
      event as never,
      ((payload: StatusEvent) => {
        const status = typeof payload === 'string' ? payload : payload.status
        if (status) {
          ;(cb as (status: Status) => void)(status)
        }
      }) as never,
    )
  }

  return emitter.addListener(event as never, cb as never)
}

export const BondfireLivePublisher = {
  isAvailable() {
    return nativeModule?.isAvailable?.() ?? Promise.resolve(false)
  },

  getCameraCount() {
    return nativeModule?.getCameraCount?.() ?? Promise.resolve(0)
  },

  startPreview(options: LivePublisherPreviewOptions) {
    return nativeModule?.startPreview?.(options) ?? unavailablePromise()
  },

  start(options: LivePublisherStartOptions) {
    return nativeModule?.start(options) ?? unavailablePromise()
  },

  stop() {
    return nativeModule?.stop() ?? unavailablePromise()
  },

  swapCamera() {
    return nativeModule?.swapCamera() ?? unavailablePromise()
  },

  setMuted(muted: boolean) {
    return nativeModule?.setMuted(muted) ?? unavailablePromise()
  },

  setVideoQuality(videoBitrate: number, fps: number) {
    return nativeModule?.setVideoQuality?.(videoBitrate, fps) ?? unavailablePromise()
  },

  getStats() {
    return nativeModule?.getStats() ?? unavailablePromise()
  },

  getThermalState() {
    return nativeModule?.getThermalState?.() ?? Promise.resolve({ level: -1, levelName: 'unknown' })
  },

  addListener,
}
