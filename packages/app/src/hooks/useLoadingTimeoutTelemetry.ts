import { useCallback, useEffect, useRef, useState } from 'react'
import { telemetry } from '../services/telemetry'
import { livePublishStore$, recordingStore$ } from '../store'

const DEFAULT_SLOW_LOAD_THRESHOLD_MS = 5_000
const DEFAULT_LOADING_TIMEOUT_MS = 15_000

type LoadingTelemetryContext = Record<string, unknown>

type UseLoadingTimeoutTelemetryOptions = {
  eventName: string
  label: string
  isLoading: boolean
  loadedCount?: number
  context?: LoadingTelemetryContext
  slowLoadThresholdMs?: number
  loadingTimeoutMs?: number
}

export function useLoadingTimeoutTelemetry({
  eventName,
  label,
  isLoading,
  loadedCount,
  context,
  slowLoadThresholdMs = DEFAULT_SLOW_LOAD_THRESHOLD_MS,
  loadingTimeoutMs = DEFAULT_LOADING_TIMEOUT_MS,
}: UseLoadingTimeoutTelemetryOptions) {
  const contextRef = useRef<LoadingTelemetryContext | undefined>(context)
  const loadStartedAtRef = useRef(Date.now())
  const slowLoadLoggedRef = useRef(false)
  const loadingTimeoutLoggedRef = useRef(false)
  const loadedLoggedRef = useRef(false)
  const [timedOut, setTimedOut] = useState(false)

  contextRef.current = context

  const getLoadingTelemetryContext = useCallback(
    (elapsedMs: number) => ({
      elapsedMs,
      ...(contextRef.current ?? {}),
      recordingPhase: recordingStore$.phase.peek(),
      liveStatus: livePublishStore$.status.peek(),
    }),
    [],
  )

  const resetLoadTracking = useCallback(() => {
    loadStartedAtRef.current = Date.now()
    slowLoadLoggedRef.current = false
    loadingTimeoutLoggedRef.current = false
    loadedLoggedRef.current = false
    setTimedOut(false)
  }, [])

  useEffect(() => {
    if (!isLoading) {
      return
    }

    const timer = setTimeout(() => {
      if (slowLoadLoggedRef.current) {
        return
      }

      slowLoadLoggedRef.current = true
      const elapsedMs = Date.now() - loadStartedAtRef.current
      telemetry.warn(`${eventName}:slow-load`, `${label} still loading after 5 seconds`, {
        ...getLoadingTelemetryContext(elapsedMs),
      })
    }, slowLoadThresholdMs)

    return () => clearTimeout(timer)
  }, [eventName, getLoadingTelemetryContext, isLoading, label, slowLoadThresholdMs])

  useEffect(() => {
    if (!isLoading) {
      return
    }

    const timer = setTimeout(() => {
      if (loadingTimeoutLoggedRef.current) {
        return
      }

      loadingTimeoutLoggedRef.current = true
      const elapsedMs = Date.now() - loadStartedAtRef.current
      telemetry.error(`${eventName}:loading-timeout`, `${label} loading timed out`, {
        ...getLoadingTelemetryContext(elapsedMs),
      })
      setTimedOut(true)
    }, loadingTimeoutMs)

    return () => clearTimeout(timer)
  }, [eventName, getLoadingTelemetryContext, isLoading, label, loadingTimeoutMs])

  useEffect(() => {
    if (isLoading || loadedCount === undefined || loadedLoggedRef.current) {
      return
    }

    loadedLoggedRef.current = true
    const elapsedMs = Date.now() - loadStartedAtRef.current
    if (slowLoadLoggedRef.current) {
      telemetry.info(`${eventName}:recovered`, `${label} recovered after slow load`, {
        ...getLoadingTelemetryContext(elapsedMs),
      })
    }

    telemetry.breadcrumb(`${eventName}:loaded`, {
      elapsedMs,
      count: loadedCount,
    })

    loadStartedAtRef.current = Date.now()
    slowLoadLoggedRef.current = false
    loadingTimeoutLoggedRef.current = false
    setTimedOut(false)
  }, [eventName, getLoadingTelemetryContext, isLoading, label, loadedCount])

  return {
    timedOut,
    resetLoadTracking,
  }
}
