import { Text } from '@bondfires/ui'
import { useMutation, useQuery } from 'convex/react'
import { Pressable } from 'react-native'
import { Separator, Switch, XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'

/**
 * Per-category push preference toggles + digest window picker, shown under
 * the master Notifications switch in profile settings. Preferences are
 * enforced server-side in convex/sendNotification.ts, so they apply to
 * email as well as push. Account-critical notifications (camp lifecycle
 * warnings) always send and have no toggle.
 */

const CATEGORIES = [
  {
    key: 'recordingActivity',
    label: 'Camp activity',
    description: 'New Bondfires and live streams in your camps',
  },
  {
    key: 'responses',
    label: 'Responses',
    description: "Responses to Bondfires you've participated in",
  },
  {
    key: 'hearth',
    label: 'Hearths',
    description: 'Your private Bondfires and who joins them',
  },
  {
    key: 'invitesAndMembership',
    label: 'Invites & membership',
    description: 'Shared Bondfires, access requests, approvals',
  },
  {
    key: 'reminders',
    label: 'Reminders',
    description: 'Daily digest of videos waiting for you',
  },
] as const

const DIGEST_HOURS = [
  { label: '8 AM', hour: 8 },
  { label: 'Noon', hour: 12 },
  { label: '5 PM', hour: 17 },
  { label: '8 PM', hour: 20 },
] as const

export function NotificationPreferencesSection() {
  const prefs = useQuery(api.notifications.getPreferences)
  const updatePreferences = useMutation(api.notifications.updatePreferences)

  if (!prefs) {
    return null
  }

  return (
    <YStack gap={16} paddingLeft={32}>
      {CATEGORIES.map((category) => (
        <XStack key={category.key} justifyContent="space-between" alignItems="center">
          <YStack flex={1} paddingRight={12}>
            <Text fontWeight="500" fontSize={14}>
              {category.label}
            </Text>
            <Text fontSize={12} color={'$placeholderColor'}>
              {category.description}
            </Text>
          </YStack>
          <Switch
            size="$2"
            checked={prefs[category.key]}
            onCheckedChange={(checked: boolean) => {
              updatePreferences({ [category.key]: checked })
            }}
            backgroundColor={'$borderColor'}
          >
            <Switch.Thumb
              animation="quick"
              backgroundColor={prefs[category.key] ? '$primary' : '$placeholderColor'}
            />
          </Switch>
        </XStack>
      ))}

      {prefs.reminders && (
        <>
          <Separator borderColor={'$borderColor'} />
          <YStack gap={8}>
            <Text fontWeight="500" fontSize={14}>
              Digest time
            </Text>
            <XStack gap={8}>
              {DIGEST_HOURS.map((option) => {
                const selected = prefs.digestWindowHour === option.hour
                return (
                  <Pressable
                    key={option.hour}
                    onPress={() => updatePreferences({ digestWindowHour: option.hour })}
                  >
                    <YStack
                      paddingHorizontal={12}
                      paddingVertical={6}
                      borderRadius={16}
                      borderWidth={1}
                      borderColor={selected ? '$primary' : '$borderColor'}
                      backgroundColor={selected ? '$primary' : 'transparent'}
                    >
                      <Text
                        fontSize={13}
                        fontWeight={selected ? '700' : '500'}
                        color={selected ? 'white' : '$color'}
                      >
                        {option.label}
                      </Text>
                    </YStack>
                  </Pressable>
                )
              })}
            </XStack>
            <Text fontSize={12} color={'$placeholderColor'}>
              One summary a day, in your local time
            </Text>
          </YStack>
        </>
      )}
    </YStack>
  )
}
