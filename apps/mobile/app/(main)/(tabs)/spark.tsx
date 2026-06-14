import { useIsFocused } from '@react-navigation/native'
import { Redirect } from 'expo-router'
import { routes } from '../../../lib/routes'

/**
 * Spark tab stub.
 *
 * The real create screen lives at `(main)/create` (a pushed stack screen) so it
 * mounts on push and FULLY unmounts on navigate-away — no lingering duplicate
 * instance fighting the active one, and no orphaned Mux live session quietly
 * costing money. This file only exists to back the Flame tab-bar entry; its
 * press handler in `(tabs)/_layout.tsx` pushes the real screen.
 *
 * IMPORTANT: this stub must NEVER navigate to a create route. An earlier version
 * redirected here to `/(main)/create` on focus, which — when react-navigation
 * briefly considered this tab focused while the real create screen was already
 * pushed on top — fired a `router.replace` that tore down and re-mounted the
 * active create screen in a ~6s loop, thrashing the camera and orphaning Mux
 * sessions. The tab is purely a button now; if navigation somehow lands here
 * directly, we bounce to the feed (a safe destination that can't re-enter the
 * create loop) and otherwise stay inert.
 */
export default function SparkTabStub() {
  const isFocused = useIsFocused()

  if (!isFocused) {
    return null
  }

  return <Redirect href={routes.feed} />
}
