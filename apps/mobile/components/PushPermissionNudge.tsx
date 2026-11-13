import { appStore$, freeUpgradeStore$, subscriptionStore$ } from '@bondfires/app'
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
 * notification permission. Without it the only in-app ask is the
 * finished-recording screen, so users who never record are never asked.
 *
 * Decides only *when* the moment is right: it stays out of the way of the
 * other global surfaces and of the create/recording route. PushPrimerSheet
 * owns device, permission and cooldown eligibility.
 */
export function PushPermissionNudge({ communityGateDismissed }: PushPermissionNudgeProps) {
  const pathname = usePathname()
  const acceptanceStatus = useQuery(api.legal.getAcceptanceStatus)
  const notificationsEnabled = useValue(appStore$.preferences.notificationsEnabled)
  const isPaywallVisible = useValue(subscriptionStore$.isPaywallVisible)
  const isExplainerVisible = useValue(freeUpgradeStore$.isExplainerVisible)

  // Wait for the acceptance status so the nudge cannot open just before the gate does.
  const communityGatePending =
    !acceptanceStatus || isCommunityAcceptanceGateOpen(acceptanceStatus, communityGateDismissed)
  const blocked =
    communityGatePending || isPaywallVisible || isExplainerVisible || isCreateRoute(pathname)

  return <PushPrimerSheet context="feed" trigger={notificationsEnabled && !blocked} />
}
