import {
  describeUploadStatus,
  retryPendingUploads,
  type UploadStatusState,
  uploadStatus$,
  uploadStatusActions,
  useRecordingResourceLock,
} from '@bondfires/app'
import { UploadStatusBanner, type UploadStatusBannerProps } from '@bondfires/ui'
import { useObserveEffect, useValue } from '@legendapp/state/react'
import { usePathname, useRouter } from 'expo-router'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react'
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context'
import { YStack } from 'tamagui'
import { routes } from '../lib/routes'

const UploadBannerVisibleContext = createContext(false)

/**
 * For screens with a fixed top padding that assumes they start under the status
 * bar. While the upload banner is showing it owns that area, so the screen only
 * needs a small gap below it.
 */
export function useHeaderTopPadding(padding: number, compact = 12) {
  return useContext(UploadBannerVisibleContext) ? compact : padding
}

type BannerVisual = Pick<UploadStatusBannerProps, 'tone' | 'icon' | 'progress'>

function bannerVisual(state: Exclude<UploadStatusState, { kind: 'idle' }>): BannerVisual {
  switch (state.kind) {
    case 'uploading':
      return { tone: 'progress', icon: 'upload', progress: state.progress ?? 'indeterminate' }
    case 'paused':
      return { tone: 'warning', icon: state.reason === 'offline' ? 'offline' : 'retry' }
    case 'failed':
      return { tone: 'error', icon: 'failed' }
    case 'completed':
      return { tone: 'success', icon: 'done' }
  }
}

function isCreateRoute(pathname: string) {
  return pathname === '/create' || pathname.startsWith('/create/')
}

/**
 * Mounts the app-wide upload status strip above every (main) screen. It sits in
 * flow — pushing content down rather than covering headers — and never shows
 * over the camera, the completion screen, or an active recording.
 */
export function UploadStatusLayout({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const recordingLocked = useRecordingResourceLock()
  const status = useValue(uploadStatus$)

  const visible = status.kind !== 'idle' && !recordingLocked && !isCreateRoute(pathname)

  // Let a held "is live" confirmation expire back to idle.
  useObserveEffect((e) => {
    const current = uploadStatus$.get()
    if (current.kind !== 'completed') return
    const timer = setTimeout(uploadStatusActions.tick, Math.max(0, current.expiresAt - Date.now()))
    e.onCleanup = () => clearTimeout(timer)
  })

  useEffect(() => {
    if (!visible) uploadStatusActions.setBannerHeight(0)
  }, [visible])
  useEffect(() => () => uploadStatusActions.setBannerHeight(0), [])

  const handleAction = useCallback(() => {
    const current = uploadStatus$.peek()
    if (current.kind === 'completed') {
      uploadStatusActions.dismissCompletion()
      if (current.bondfireId) router.push(routes.bondfire(current.bondfireId))
      return
    }
    retryPendingUploads()
  }, [router])

  const childInsets = useMemo(() => (visible ? { ...insets, top: 0 } : insets), [insets, visible])

  return (
    <UploadBannerVisibleContext.Provider value={visible}>
      <YStack flex={1}>
        {visible ? (
          <UploadStatusBanner
            {...bannerVisual(status)}
            {...describeUploadStatus(status)}
            onAction={handleAction}
            topInset={insets.top}
            onLayout={(event) =>
              uploadStatusActions.setBannerHeight(event.nativeEvent.layout.height)
            }
          />
        ) : null}
        <SafeAreaInsetsContext.Provider value={childInsets}>
          <YStack flex={1}>{children}</YStack>
        </SafeAreaInsetsContext.Provider>
      </YStack>
    </UploadBannerVisibleContext.Provider>
  )
}
