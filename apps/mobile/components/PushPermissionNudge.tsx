import {
  appSessionStore$,
  appStore$,
  freeUpgradeStore$,
  hasRecordedVideo,
  subscriptionStore$,
} from '@bondfires/app'
import { useValue } from '@legendapp/state/react'
import { useQuery } from 'convex/react'
import { usePathname } from 'expo-router'
import { api } from '../../../convex/_generated/api'
import { isCommunityAcceptanceGateOpen } from './CommunityAcceptanceGate'
import { PushPrimerSheet } from './PushPrimerSheet'
import { isCreateRoute } from './UploadStatusLayout'

interface PushPermissionNudgeProps {
  /** Session "Not now" state of the CommunityAcceptanceGate, owned by the main layout. */
  communityGateDismissed: boolean
}

/**
 * Global push permission nudge for signed-in users who have not granted OS
 * notification permission. The finished-recording screen asks once, right
 * after a recording; this asks again on the feed in later app sessions, so a
 * user who said "Not now" there is asked once per session (up to the decline
 * cap) instead of never again.
 *
 * Waits until the user has recorded a video, so the ask comes when they have
 * something to hear back about. Decides only *when* the moment is right: it
 * stays out of the way of the other global surfaces and of the create/recording
 * route. PushPrimerSheet owns device, permission and once-per-session
 * eligibility.
 */
export function PushPermissionNudge({ communityGateDismissed }: PushPermissionNudgeProps) {
  const pathname = usePathname()
  const acceptanceStatus = useQuery(api.legal.getAcceptanceStatus)
  const user = useQuery(api.users.current)
  // A new session remounts the sheet so it re-checks eligibility.
  const sessionStartedAt = useValue(appSessionStore$.startedAt)
  const notificationsEnabled = useValue(appStore$.preferences.notificationsEnabled)
  const isPaywallVisible = useValue(subscriptionStore$.isPaywallVisible)
  const isExplainerVisible = useValue(freeUpgradeStore$.isExplainerVisible)

  // Wait for the acceptance status so the nudge cannot open just before the gate does.
  const communityGatePending =
    !acceptanceStatus || isCommunityAcceptanceGateOpen(acceptanceStatus, communityGateDismissed)
  const blocked =
    !hasRecordedVideo(user) ||
    communityGatePending ||
    isPaywallVisible ||
    isExplainerVisible ||
    isCreateRoute(pathname)

  return (
    <PushPrimerSheet
      key={sessionStartedAt}
      context="feed"
      trigger={notificationsEnabled && !blocked}
    />
  )
}
