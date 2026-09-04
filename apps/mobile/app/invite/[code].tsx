import { appStore$ } from '@bondfires/app'
import { useValue } from '@legendapp/state/react'
import { useMutation, useQuery } from 'convex/react'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { api } from '../../../../convex/_generated/api'
import { InviteRedemptionScreen } from '../../components/InviteRedemptionScreen'
import { routes } from '../../lib/routes'

export default function InviteScreen() {
  const { code } = useLocalSearchParams<{ code: string | string[] }>()
  const normalizedCode = Array.isArray(code) ? code[0] : code
  const isAuthenticated = useValue(appStore$.isAuthenticated)
  const redeemInvite = useMutation(api.inviteClaims.redeemInviteCode)
  const familyInvite = useQuery(
    api.familyConnections.checkInvite,
    normalizedCode ? { code: normalizedCode } : 'skip',
  )

  if (normalizedCode && familyInvite?.valid) {
    return <Redirect href={routes.externalFamilyInvite(normalizedCode)} />
  }

  return (
    <InviteRedemptionScreen
      code={code}
      isAuthenticated={isAuthenticated}
      loginHref={routes.loginWithInvite}
      redeemInvite={async (inviteCode) => {
        const result = await redeemInvite({ code: inviteCode })
        if (result.type === 'camp') return routes.camp(result.campId)
        if (result.type === 'family-connection') {
          return routes.externalFamilyInvite(result.code)
        }
        return routes.bondfire(result.bondfireId)
      }}
      loadingText="Redeeming invite..."
      successText="Taking you there now."
      fallbackErrorText="Something went wrong. The invite may have expired."
    />
  )
}
