import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { AlertTriangle } from '@tamagui/lucide-icons'
import { Spinner, XStack, YStack } from 'tamagui'
import type { WarningStepProps } from './types'

export function WarningStep({
  isSubmitting,
  error,
  onSubmit,
  onBack,
}: WarningStepProps) {
  return (
    <YStack gap={16} alignItems="center">
      <YStack
        width={64}
        height={64}
        borderRadius={32}
        backgroundColor={bondfireColors.warning}
        alignItems="center"
        justifyContent="center"
      >
        <AlertTriangle size={32} color={bondfireColors.obsidian} />
      </YStack>
      <Text
        fontSize={18}
        fontWeight="600"
        color={bondfireColors.whiteSmoke}
        textAlign="center"
      >
        Before You Submit
      </Text>
      <Text fontSize={14} color={bondfireColors.ash} textAlign="center">
        Please only submit reports for genuine concerns. False or malicious
        reports may result in action against your account.
      </Text>
      {error && (
        <Text fontSize={14} color={bondfireColors.error} textAlign="center">
          {error}
        </Text>
      )}
      <XStack gap={12} width="100%">
        <Button
          variant="secondary"
          size="$md"
          flex={1}
          onPress={onBack}
          disabled={isSubmitting}
        >
          <Text color={bondfireColors.whiteSmoke}>Go Back</Text>
        </Button>
        <Button
          variant="destructive"
          size="$md"
          flex={1}
          onPress={onSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <Spinner size="small" color={bondfireColors.whiteSmoke} />
          ) : (
            <Text color={bondfireColors.whiteSmoke} fontWeight="600">
              Submit Report
            </Text>
          )}
        </Button>
      </XStack>
    </YStack>
  )
}
