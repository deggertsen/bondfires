import { useIsFocused } from '@react-navigation/native'
import { Redirect, useLocalSearchParams } from 'expo-router'
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
 * If navigation lands here directly (e.g. an OS deep link to the tab path),
 * bounce to the real screen — but only while focused, so a lazy/unfocused tab
 * mount stays inert and never yanks the user off another tab.
 */
export default function CreateTabStub() {
  const isFocused = useIsFocused()
  const params = useLocalSearchParams<{
    campId?: string
    respondTo?: string
    personalCamp?: string
    newFire?: string
  }>()

  if (!isFocused) {
    return null
  }

  const href = params.respondTo
    ? routes.createRespondTo(params.respondTo)
    : params.campId
      ? routes.createForCamp(params.campId)
      : params.personalCamp === '1'
        ? routes.createForPersonalCamp(params.newFire)
        : routes.create

  return <Redirect href={href} />
}
