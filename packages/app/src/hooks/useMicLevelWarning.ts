import { useEffect, useState } from 'react'
import { telemetry } from '../services/telemetry'
import {
  createMicLevelWarning,
  MIC_LOW_WINDOW_MS,
  MIC_MAX_SAMPLE_GAP_MS,
  MIC_SAMPLE_INTERVAL_MS,
  type MicLevelStats,
} from '../utils/micLevelWarning'

/** Only mounted R2 recording sessions poll; preview and muted input never arm. */
export function useMicLevelWarning({
  publisher,
  recording,
  recordingId,
}: {
  publisher: { getStats(): Promise<MicLevelStats> }
  recording: boolean
  recordingId: string
}) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    setVisible(false)
    if (!recording) return
    const detector = createMicLevelWarning()
    let disposed = false
    let inFlight = false
    let wasVisible = false
    let lastSampleAt: number | null = null
    let lastBreadcrumb: number | null = null
    const reset = () => {
      detector.reset()
      lastSampleAt = null
      wasVisible = false
      setVisible(false)
    }
    const poll = async () => {
      const requestedAt = performance.now()
      // A stuck native request must not keep an old warning on screen. Keep
      // one request in flight, but expire its evidence independently of replies.
      if (lastSampleAt !== null && requestedAt - lastSampleAt > MIC_MAX_SAMPLE_GAP_MS) reset()
      if (inFlight) return
      inFlight = true
      try {
        const stats = await publisher.getStats()
        if (disposed) return
        const now = performance.now()
        if (now - requestedAt > MIC_MAX_SAMPLE_GAP_MS) {
          reset()
          return
        }
        // Native may snapshot PCM before resolving. Use the request time so
        // bridge latency cannot extend the period of observed quiet input.
        const next = detector.sample(stats, requestedAt, true)
        lastSampleAt = requestedAt
        const fields = {
          recordingId,
          micLevelDb: stats.micLevelDb,
          appliedGainDb: stats.appliedGainDb,
          micLowThresholdDb: stats.micLowThresholdDb,
          micSampleCount: stats.micSampleCount,
          micMuted: stats.micMuted,
        }
        if (lastBreadcrumb === null || now - lastBreadcrumb >= 30_000) {
          telemetry.breadcrumb('live:stats_sample', fields)
          lastBreadcrumb = now
        }
        if (next && !wasVisible) {
          telemetry.info('live:audio_level_warning', 'Sustained low microphone input', {
            ...fields,
            windowMs: MIC_LOW_WINDOW_MS,
          })
        }
        wasVisible = next
        setVisible(next)
      } catch {
        if (disposed) return
        reset()
      } finally {
        inFlight = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), MIC_SAMPLE_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [publisher, recording, recordingId])
  return recording && visible
}
