import { telemetry, useAppThemeColors } from '@bondfires/app'
import { Button, Card, Spinner, Text, UserAvatar } from '@bondfires/ui'
import { ArrowLeft, ShieldCheck } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { Stack, useRouter } from 'expo-router'
import { Alert, Pressable, ScrollView, StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'

export default function FamilyConnectionsScreen() {
  const router = useRouter()
  const { colors, statusBarStyle } = useAppThemeColors()
  const connections = useQuery(api.familyConnections.listMine)
  const revoke = useMutation(api.familyConnections.revoke)

  const confirmRevoke = (connectionId: Id<'familyConnections'>, name: string) => {
    Alert.alert(
      'Remove family connection?',
      `${name} will immediately lose access to Hearth Bondfires shared through this connection. You can reconnect later only with a new invitation.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await revoke({ connectionId })
            } catch (error) {
              telemetry.warn('familyConnection:revoke', 'Failed to revoke family connection', {
                error: String(error),
              })
              Alert.alert(
                'Could not remove connection',
                error instanceof Error ? error.message : 'Please try again.',
              )
            }
          },
        },
      ],
    )
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <YStack flex={1} backgroundColor="$background">
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <XStack
          alignItems="center"
          gap={14}
          paddingTop={58}
          paddingHorizontal={20}
          paddingBottom={18}
        >
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <YStack
              width={42}
              height={42}
              borderRadius={21}
              alignItems="center"
              justifyContent="center"
              backgroundColor="$backgroundHover"
            >
              <ArrowLeft size={22} color="$color" />
            </YStack>
          </Pressable>
          <Text fontSize={24} fontWeight="900">
            Family Connections
          </Text>
        </XStack>

        <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 4, paddingBottom: 48 }}>
          <Card marginBottom={20}>
            <XStack gap={12} alignItems="flex-start">
              <ShieldCheck size={24} color="$primary" />
              <YStack flex={1} gap={6}>
                <Text fontWeight="800">Private, controlled Hearth access</Text>
                <Text color="$placeholderColor" lineHeight={20}>
                  Family connections allow people in different age groups to share private Hearth
                  Bondfires. They never make either account discoverable in public Camps, search, or
                  recommendations. Bondfires does not verify legal or biological relationships.
                </Text>
              </YStack>
            </XStack>
          </Card>

          {connections === undefined ? (
            <Spinner size="large" color="$primary" marginTop={24} />
          ) : connections.length === 0 ? (
            <YStack alignItems="center" paddingVertical={32} gap={10}>
              <Text fontSize={18} fontWeight="800" textAlign="center">
                No family connections yet
              </Text>
              <Text color="$placeholderColor" textAlign="center" lineHeight={20}>
                Create a Hearth Bondfire, open its invite options, and choose “Create family link.”
                The other person must explicitly accept it.
              </Text>
            </YStack>
          ) : (
            <YStack gap={12}>
              {connections.map((connection) => {
                const name = connection.user.displayName ?? connection.user.name ?? 'Family member'
                return (
                  <Card key={connection._id}>
                    <XStack alignItems="center" gap={12}>
                      <UserAvatar name={name} photoUrl={connection.user.photoUrl} size={52} />
                      <YStack flex={1} gap={3}>
                        <Text fontWeight="800">{name}</Text>
                        <Text color="$placeholderColor" fontSize={12}>
                          Connected privately for Hearth invitations
                        </Text>
                      </YStack>
                      <Button
                        variant="outline"
                        size="$sm"
                        onPress={() => confirmRevoke(connection._id, name)}
                        accessibilityLabel={`Remove family connection with ${name}`}
                      >
                        <Text color="$error" fontWeight="700">
                          Remove
                        </Text>
                      </Button>
                    </XStack>
                  </Card>
                )
              })}
            </YStack>
          )}
        </ScrollView>
      </YStack>
    </>
  )
}
