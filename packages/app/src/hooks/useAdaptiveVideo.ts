import { useCallback, useEffect, useState } from 'react'

interface UseAdaptiveVideoOptions {
  hdUrl: string
  sdUrl: string | null
  onSwitchToSD?: () => void
}

interface UseAdaptiveVideoReturn {
  currentUrl: string
  hasSwitchedToSD: boolean
  switchToSD: () => void
}

/**
 * Hook for adaptive video quality switching.
 * Provides manual switch to SD and tracks quality state.
 * Actual buffering detection is handled in the VideoPlayer component.
 */
export function useAdaptiveVideo({
  hdUrl,
  sdUrl,
  onSwitchToSD,
}: UseAdaptiveVideoOptions): UseAdaptiveVideoReturn {
  const [currentUrl, setCurrentUrl] = useState(hdUrl)
  const [hasSwitchedToSD, setHasSwitchedToSD] = useState(false)

  const switchToSD = useCallback(() => {
    if (!sdUrl || hasSwitchedToSD) return

    setCurrentUrl(sdUrl)
    setHasSwitchedToSD(true)
    onSwitchToSD?.()
  }, [sdUrl, hasSwitchedToSD, onSwitchToSD])

  // Reset when HD URL changes
  useEffect(() => {
    setCurrentUrl(hdUrl)
    setHasSwitchedToSD(false)
  }, [hdUrl])

  return {
    currentUrl,
    hasSwitchedToSD,
    switchToSD,
  }
}
