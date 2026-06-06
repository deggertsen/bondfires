import { appStore$ } from '@bondfires/app'
import { useValue } from '@legendapp/state/react'
import { useMutation } from 'convex/react'
import { useLocalSearchParams } from 'expo-router'
import { api } from '../../../../../convex/_generated/api'
import { InviteRedemptionScreen } from '../../../components/InviteRedemptionScreen'
import { routes } from '../../../lib/routes'

export default function CampInviteScreen() {
  const { code } = useLocalSearchParams<{ code: string | string[] }>()
  const isAuthenticated = useValue(appStore$.isAuthenticated)
  const redeemInvite = useMutation(api.camps.redeemInvite)

  return (
    <InviteRedemptionScreen
      code={code}
      isAuthenticated={isAuthenticated}
      loginHref={routes.loginWithCampInvite}
      redeemInvite={async (inviteCode) => {
        const result = await redeemInvite({ code: inviteCode })
        return routes.camp(result.campId)
      }}
      loadingText="Joining camp..."
      successText="Taking you to the camp now."
      fallbackErrorText="Something went wrong. The invite may have expired or the camp is full."
    />
  )
}
