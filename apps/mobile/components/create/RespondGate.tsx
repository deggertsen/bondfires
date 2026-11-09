import { useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useQuery } from 'convex/react'
import { Redirect, useNavigation, useRouter } from 'expo-router'
import type { ReactNode } from 'react'
import { StatusBar } from 'react-native'
import { YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import { goBackOrReplace } from '../../lib/navigation'
import { decideRespondGate } from '../../lib/respondGate'
import { createRespondToPath, routes } from '../../lib/routes'

/** All Respond entry points pass here before permission hooks or capture mount. */
export function RespondGate({
  bondfireId,
  children,
}: {
  bondfireId?: string
  children: ReactNode
}) {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const navigation = useNavigation()
  const context = useQuery(
    api.bondfires.getWithCampContext,
    bondfireId ? { id: bondfireId } : 'skip',
  )
  // New sparks do not need a response-target lookup.
  if (!bondfireId) return children

  const decision = decideRespondGate(context)
  if (decision.kind === 'respond') return children
  if (decision.kind === 'join') {
    return <Redirect href={routes.campJoinGate(decision.campId, createRespondToPath(bondfireId))} />
  }
  return (
    <YStack flex={1} backgroundColor="$background" justifyContent="center" padding="$4" gap="$3">
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      {decision.kind === 'loading' ? (
        <Spinner />
      ) : (
        <>
          <Text fontSize={20} fontWeight="600">
            Response unavailable
          </Text>
          <Text color="$placeholderColor">You can no longer respond to this bondfire.</Text>
          <Button onPress={() => goBackOrReplace(router, navigation, routes.feed)}>Go Back</Button>
        </>
      )}
    </YStack>
  )
}
