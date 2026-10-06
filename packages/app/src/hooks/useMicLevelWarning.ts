import { useEffect, useState } from 'react'
import { telemetry } from '../services/telemetry'
import {
  createMicLevelWarning,
  MIC_LOW_WINDOW_MS,
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
    let lastBreadcrumb: number | null = null
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const stats = await publisher.getStats()
        if (disposed) return
        const now = performance.now()
        const next = detector.sample(stats, now, true)
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
        detector.reset()
        wasVisible = false
        setVisible(false)
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
