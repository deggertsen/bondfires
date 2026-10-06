import {
  completeBannerExit,
  describeUploadStatus,
  isUploadStatusHidden,
  nextBannerPresence,
  retryPendingUploads,
  UPLOAD_BANNER_HIDDEN,
  type UploadBannerPresence,
  type UploadStatusState,
  uploadStatus$,
  uploadStatusActions,
  uploadStatusStore$,
  useRecordingResourceLock,
} from '@bondfires/app'
import { UploadStatusBanner, type UploadStatusBannerProps } from '@bondfires/ui'
import { useObserveEffect, useValue } from '@legendapp/state/react'
import { usePathname, useRouter } from 'expo-router'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context'
import { YStack } from 'tamagui'
import { routes } from '../lib/routes'

const UploadBannerVisibleContext = createContext(false)

/**
 * Safety net: unmount the strip this long after its exit starts even if the
 * animation never reports completion (the collapse itself takes 260ms).
 */
const BANNER_EXIT_FALLBACK_MS = 400

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

function bannerFromState(state: UploadStatusState) {
  if (state.kind === 'idle') return null
  return { visual: bannerVisual(state), copy: describeUploadStatus(state) }
}

/**
 * Keeps the strip mounted while it animates away. `mounted` is "is the strip
 * occupying space right now" — the signal the screens below follow — and
 * `exiting` drives the strip's collapse. `finishExit` is what the strip calls
 * when its animation completes; it is safe to call late (after a re-show).
 */
function useUploadBannerPresence(visible: boolean, immediateHide: boolean) {
  const [presence, setPresence] = useState<UploadBannerPresence>(() =>
    nextBannerPresence(UPLOAD_BANNER_HIDDEN, { visible, immediateHide }),
  )

  useEffect(() => {
    setPresence((prev) => nextBannerPresence(prev, { visible, immediateHide }))
  }, [visible, immediateHide])

  const finishExit = useCallback(() => setPresence(completeBannerExit), [])

  useEffect(() => {
    if (!presence.exiting) return
    const timer = setTimeout(finishExit, BANNER_EXIT_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [presence.exiting, finishExit])

  return { ...presence, finishExit }
}

/**
 * Mounts the app-wide upload status strip above every (main) screen. It sits in
 * flow — pushing content down rather than covering headers — and never shows
 * over the camera, the completion screen, or an active recording. Swiping it
 * right hides it for the rest of the app session; uploads keep running.
 *
 * On hide the strip animates its own height away. Screens below are held at
 * their compact top padding for the whole time the strip occupies space
 * so they move up smoothly with it instead of snapping.
 */
export function UploadStatusLayout({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const recordingLocked = useRecordingResourceLock()
  const status = useValue(uploadStatus$)
  const hiddenAt = useValue(uploadStatusStore$.hiddenAt)

  // Camera/recording and the create route hide the strip instantly — it must
  // never animate over the camera or the completion screen.
  const immediateHide = recordingLocked || isCreateRoute(pathname)

  const visible =
    status.kind !== 'idle' && !isUploadStatusHidden(status, hiddenAt) && !immediateHide

  // Let a held "is live" confirmation expire back to idle.
  useObserveEffect((e) => {
    const current = uploadStatus$.get()
    if (current.kind !== 'completed') return
    const timer = setTimeout(uploadStatusActions.tick, Math.max(0, current.expiresAt - Date.now()))
    e.onCleanup = () => clearTimeout(timer)
  })

  const { mounted, exiting, finishExit } = useUploadBannerPresence(visible, immediateHide)

  // Remember the last non-idle content so the strip can keep rendering while it
  // collapses, after the underlying status has already gone idle.
  const banner = useMemo(() => bannerFromState(status), [status])
  const lastBanner = useRef(banner)
  useEffect(() => {
    if (banner) lastBanner.current = banner
  }, [banner])
  const currentBanner = banner ?? lastBanner.current

  // `bannerShown` — not `visible` — is what the rest of the app keys off, so the
  // compact-padding hand-off happens when the strip actually leaves the tree,
  // at the end of the animation, not when the upload status goes idle.
  const bannerShown = mounted && currentBanner !== null

  useEffect(() => {
    if (!bannerShown) uploadStatusActions.setBannerHeight(0)
  }, [bannerShown])
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

  const childInsets = useMemo(
    () => (bannerShown ? { ...insets, top: 0 } : insets),
    [insets, bannerShown],
  )

  return (
    <UploadBannerVisibleContext.Provider value={bannerShown}>
      <YStack flex={1}>
        {bannerShown && currentBanner ? (
          <UploadStatusBanner
            {...currentBanner.visual}
            {...currentBanner.copy}
            exiting={exiting}
            onExitComplete={finishExit}
            onAction={handleAction}
            onDismiss={uploadStatusActions.hideForSession}
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
