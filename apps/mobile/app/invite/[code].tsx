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
  const redeemInvite = useMutation(api.inviteClaims.redeemInviteCode)

  return (
    <InviteRedemptionScreen
      code={code}
      isAuthenticated={isAuthenticated}
      loginHref={routes.loginWithInvite}
      redeemInvite={async (inviteCode) => {
        const result = await redeemInvite({ code: inviteCode })
        return result.type === 'camp'
          ? routes.camp(result.campId)
          : routes.bondfire(result.bondfireId)
      }}
      loadingText="Redeeming invite..."
      successText="Taking you there now."
      fallbackErrorText="Something went wrong. The invite may have expired."
    />
  )
}
