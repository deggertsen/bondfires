import { appStore$ } from '@bondfires/app'
import { useValue } from '@legendapp/state/react'
import { useMutation } from 'convex/react'
import { useLocalSearchParams } from 'expo-router'
import { api } from '../../../../convex/_generated/api'
import { InviteRedemptionScreen } from '../../components/InviteRedemptionScreen'
import { routes } from '../../lib/routes'

export default function InviteScreen() {
  const { code } = useLocalSearchParams<{ code: string | string[] }>()
  const isAuthenticated = useValue(appStore$.isAuthenticated)
  const redeemInvite = useMutation(api.personalBondfires.redeemInvite)

  return (
    <InviteRedemptionScreen
      code={code}
      isAuthenticated={isAuthenticated}
      loginHref={routes.loginWithInvite}
      redeemInvite={async (inviteCode) => {
        const result = await redeemInvite({ code: inviteCode })
        return routes.bondfire(result.bondfireId)
      }}
      loadingText="Joining personal bondfire..."
      successText="Taking you to the conversation now."
      fallbackErrorText="Something went wrong. The invite may have expired or the fire is full."
    />
  )
}
