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
type EventSubscription = { remove: () => void }

interface NativeLivePublisher {
  isAvailable?: () => Promise<boolean>
  getCameraCount?: () => Promise<number>
  startPreview?: (options: LivePublisherPreviewOptions) => Promise<void>
  start(options: LivePublisherStartOptions): Promise<void>
  stop(): Promise<void>
  swapCamera(): Promise<void>
  setMuted(muted: boolean): Promise<void>
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
  (event: 'error', cb: (error: { code: string; message: string }) => void): EventSubscription
}

const addListener: AddListener = (
  event: 'statusChange' | 'error',
  cb: ((status: Status) => void) | ((error: { code: string; message: string }) => void),
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

  getStats() {
    return nativeModule?.getStats() ?? unavailablePromise()
  },

  getThermalState() {
    return nativeModule?.getThermalState?.() ?? Promise.resolve({ level: -1, levelName: 'unknown' })
  },

  addListener,
}
