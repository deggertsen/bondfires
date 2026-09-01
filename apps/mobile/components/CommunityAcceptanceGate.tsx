import { Button, Card, Text } from '@bondfires/ui'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { Alert, Linking, Modal } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'

const TERMS_URL = 'https://bondfires.org/terms'
const GUIDELINES_URL = 'https://bondfires.org/community-guidelines'
const PRIVACY_URL = 'https://bondfires.org/privacy'

export function CommunityAcceptanceGate() {
  const status = useQuery(api.legal.getAcceptanceStatus)
  const accept = useMutation(api.legal.acceptCurrent)
  const [isAccepting, setIsAccepting] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  if (!status || status.accepted || dismissed) return null

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => setDismissed(true)}>
      <YStack flex={1} backgroundColor="rgba(0,0,0,0.72)" justifyContent="center" padding={24}>
        <Card accessibilityRole="summary">
          <YStack gap={16}>
            <Text fontSize={22} fontWeight="800">
              Our community commitments
            </Text>
            <Text color={'$placeholderColor'}>
              Before posting or responding, review and accept the current Terms and Community
              Guidelines. They explain prohibited content, reporting, blocking, and moderation.
            </Text>
            <XStack gap={8} flexWrap="wrap">
              <Button
                variant="outline"
                size="$sm"
                onPress={() => Linking.openURL(TERMS_URL)}
                accessibilityLabel="Open Terms of Service"
              >
                <Text>Terms</Text>
              </Button>
              <Button
                variant="outline"
                size="$sm"
                onPress={() => Linking.openURL(GUIDELINES_URL)}
                accessibilityLabel="Open Community Guidelines"
              >
                <Text>Guidelines</Text>
              </Button>
              <Button
                variant="outline"
                size="$sm"
                onPress={() => Linking.openURL(PRIVACY_URL)}
                accessibilityLabel="Open Privacy Policy"
              >
                <Text>Privacy</Text>
              </Button>
            </XStack>
            <Button
              variant="primary"
              size="$lg"
              disabled={isAccepting}
              onPress={async () => {
                setIsAccepting(true)
                try {
                  await accept()
                } catch (error) {
                  Alert.alert(
                    'Unable to save acceptance',
                    error instanceof Error ? error.message : 'Please try again.',
                  )
                } finally {
                  setIsAccepting(false)
                }
              }}
              accessibilityLabel="Accept Terms and Community Guidelines"
            >
              <Text>{isAccepting ? 'Saving…' : 'I Agree'}</Text>
            </Button>
            <Button
              variant="outline"
              size="$md"
              disabled={isAccepting}
              onPress={() => setDismissed(true)}
              accessibilityLabel="Review community policies later"
            >
              <Text>Not now</Text>
            </Button>
            <Text fontSize={12} color={'$placeholderColor'}>
              Posting and responding stay disabled until you accept. Terms {status.termsVersion} ·
              Guidelines {status.communityGuidelinesVersion}
            </Text>
          </YStack>
        </Card>
      </YStack>
    </Modal>
  )
}
