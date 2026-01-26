import { useCallback, useEffect } from 'react'
import { useObservable, useValue } from '@legendapp/state/react'

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
  const state$ = useObservable({
    currentUrl: hdUrl,
    hasSwitchedToSD: false,
  })

  const switchToSD = useCallback(() => {
    if (!sdUrl || state$.hasSwitchedToSD.get()) return

    state$.currentUrl.set(sdUrl)
    state$.hasSwitchedToSD.set(true)
    onSwitchToSD?.()
  }, [sdUrl, state$, onSwitchToSD])

  // Reset when HD URL changes (prop-based, keep useEffect)
  useEffect(() => {
    state$.currentUrl.set(hdUrl)
    state$.hasSwitchedToSD.set(false)
  }, [hdUrl, state$])

  return {
    currentUrl: useValue(state$.currentUrl),
    hasSwitchedToSD: useValue(state$.hasSwitchedToSD),
    switchToSD,
  }
}
