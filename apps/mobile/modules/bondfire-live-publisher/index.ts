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

export interface LivePublisherStats {
  bitrateBps: number
  rttMs: number
  droppedFrames: number
}

export interface LivePublisherViewProps extends ViewProps {}

type Status = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'errored' | 'ended'
type EventSubscription = { remove: () => void }

interface NativeLivePublisher {
  isAvailable?: () => Promise<boolean>
  start(options: LivePublisherStartOptions): Promise<void>
  stop(): Promise<void>
  swapCamera(): Promise<void>
  setMuted(muted: boolean): Promise<void>
  getStats(): Promise<LivePublisherStats>
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

  return emitter.addListener(event as never, cb as never)
}

export const BondfireLivePublisher = {
  isAvailable() {
    return nativeModule?.isAvailable?.() ?? Promise.resolve(false)
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

  addListener,
}
