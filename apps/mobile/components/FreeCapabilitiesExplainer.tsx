import { freeUpgradeActions, freeUpgradeStore$ } from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Map, MessageCircle, PlayCircle } from '@tamagui/lucide-icons'
import { Modal, Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'

const CAPABILITIES = [
  {
    Icon: Map,
    title: 'Join camps',
    body: 'Browse and join any camp open to your tier.',
  },
  {
    Icon: PlayCircle,
    title: 'Watch Bondfires',
    body: 'Scroll the feed and watch every fire.',
  },
  {
    Icon: MessageCircle,
    title: 'Respond to Bondfires',
    body: 'Record a response video (up to 5 minutes) to any fire.',
  },
] as const

/**
 * "What can I do for free?" explainer (W1). A globally-mounted modal that
 * communicates the respond-first free identity — what free users *can* do —
 * with a single "View Plans" CTA for the upgrade journey. Reachable from the
 * live-screen safety net, the Hearth card, and the Feed summary card.
 */
export function FreeCapabilitiesExplainer() {
  const isVisible = useValue(freeUpgradeStore$.isExplainerVisible)

  return (
    <Modal
      visible={isVisible}
      transparent
      animationType="fade"
      onRequestClose={() => freeUpgradeActions.hideExplainer()}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={{ flex: 1 }}
        onPress={() => freeUpgradeActions.hideExplainer()}
      >
        <YStack
          flex={1}
          backgroundColor="rgba(0,0,0,0.7)"
          alignItems="center"
          justifyContent="center"
          padding={24}
        >
          {/* Stop propagation so taps inside the card don't dismiss it. */}
          <Pressable onPress={() => {}}>
            <YStack
              backgroundColor={'$background'}
              borderRadius={20}
              borderWidth={1}
              borderColor={'$borderColor'}
              padding={24}
              gap={20}
              width="100%"
              maxWidth={400}
            >
              <YStack gap={6}>
                <Text fontSize={22} fontWeight="900">
                  What you get for free
                </Text>
                <Text fontSize={14} color={'$placeholderColor'} lineHeight={20}>
                  Bondfires is respond-first. Here's everything you can do today — no upgrade
                  needed.
                </Text>
              </YStack>

              <YStack gap={16}>
                {CAPABILITIES.map(({ Icon, title, body }) => (
                  <XStack key={title} gap={14} alignItems="center">
                    <YStack
                      width={42}
                      height={42}
                      borderRadius={21}
                      backgroundColor={'$backgroundHover'}
                      alignItems="center"
                      justifyContent="center"
                    >
                      <Icon size={22} color={'$primary'} />
                    </YStack>
                    <YStack flex={1} gap={2}>
                      <Text fontSize={16} fontWeight="900">
                        {title}
                      </Text>
                      <Text fontSize={13} color={'$placeholderColor'} lineHeight={18}>
                        {body}
                      </Text>
                    </YStack>
                  </XStack>
                ))}
              </YStack>

              <Button
                variant="primary"
                size="$lg"
                accessibilityLabel="View subscription plans"
                onPress={() => freeUpgradeActions.openPaywallFromExplainer()}
              >
                <Text color={'$color'} fontWeight="900">
                  View Plans
                </Text>
              </Button>
            </YStack>
          </Pressable>
        </YStack>
      </Pressable>
    </Modal>
  )
}
