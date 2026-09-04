import { Button, Card, Text, UserAvatar } from '@bondfires/ui'
import { Shield } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { Alert, Linking } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'

export function SafetySettings() {
  const blocked = useQuery(api.userSafety.listBlocked)
  const unblock = useMutation(api.userSafety.unblock)

  return (
    <Card marginBottom={24}>
      <YStack gap={12}>
        <XStack gap={8} alignItems="center">
          <Shield size={18} color={'$secondary'} />
          <Text fontSize={16} fontWeight="700">
            Safety & legal
          </Text>
        </XStack>
        <XStack gap={8} flexWrap="wrap">
          <Button
            size="$sm"
            variant="outline"
            onPress={() => Linking.openURL('https://bondfires.org/terms')}
          >
            <Text>Terms</Text>
          </Button>
          <Button
            size="$sm"
            variant="outline"
            onPress={() => Linking.openURL('https://bondfires.org/community-guidelines')}
          >
            <Text>Community Guidelines</Text>
          </Button>
          <Button
            size="$sm"
            variant="outline"
            onPress={() => Linking.openURL('https://bondfires.org/privacy')}
          >
            <Text>Privacy</Text>
          </Button>
          <Button
            size="$sm"
            variant="outline"
            onPress={() => Linking.openURL('mailto:safety@bondfires.org')}
          >
            <Text>Contact safety</Text>
          </Button>
        </XStack>
        {(blocked ?? []).map((entry) => (
          <XStack key={entry._id} alignItems="center" gap={10}>
            <UserAvatar name={entry.displayName} photoUrl={entry.photoUrl} size={36} />
            <Text flex={1}>{entry.displayName}</Text>
            <Button
              size="$sm"
              variant="outline"
              accessibilityLabel={`Unblock ${entry.displayName}`}
              onPress={async () => {
                try {
                  await unblock({ userId: entry.blockedUserId })
                } catch (error) {
                  Alert.alert(
                    'Unable to unblock user',
                    error instanceof Error ? error.message : 'Try again.',
                  )
                }
              }}
            >
              <Text>Unblock</Text>
            </Button>
          </XStack>
        ))}
      </YStack>
    </Card>
  )
}
