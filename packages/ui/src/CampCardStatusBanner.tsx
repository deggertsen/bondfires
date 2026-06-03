import { bondfireColors } from '@bondfires/config'
import { YStack } from 'tamagui'
import { Text } from './Text'

type BannerVariant = 'pending' | 'rejected'

function getBannerConfig(variant: BannerVariant) {
  switch (variant) {
    case 'pending':
      return {
        label: 'Awaiting Approval',
        bgColor: bondfireColors.warning,
        textColor: bondfireColors.obsidian,
      }
    case 'rejected':
      return {
        label: 'Request Denied',
        bgColor: bondfireColors.error,
        textColor: bondfireColors.whiteSmoke,
      }
  }
}

/**
 * Diagonal corner banner for camp cards showing membership status.
 * Displays in the top-left corner at a 45° angle.
 */
export function CampCardStatusBanner({ variant }: { variant: BannerVariant }) {
  const config = getBannerConfig(variant)

  return (
    <YStack
      position="absolute"
      top={0}
      left={0}
      width={140}
      height={42}
      backgroundColor={config.bgColor}
      alignItems="center"
      justifyContent="center"
      transform={[{ rotate: '-45deg' }, { translateX: -38 }, { translateY: 12 }]}
      zIndex={10}
    >
      <Text fontSize={11} fontWeight="900" color={config.textColor} textTransform="uppercase">
        {config.label}
      </Text>
    </YStack>
  )
}
