import { type GetProps, styled } from 'tamagui'
import {
  CardFrame as CardBehaviorFrame,
  CardFooter as CardFooterBehavior,
  CardHeader as CardHeaderBehavior,
} from 'tamagui/unstyled'

// Built on Tamagui's unstyled card parts: the v3 default skin adds a size
// ladder (radius/padding names this config doesn't define) under these styles.
export const Card = styled(CardBehaviorFrame, {
  name: 'Card',
  // Use Bondfire gunmetal for card background
  backgroundColor: 'backgroundHover',
  borderRadius: 12,
  padding: '4',
  borderWidth: 1,
  borderColor: 'borderColor',
  overflow: 'hidden',

  variants: {
    elevated: {
      true: {
        // v1: shadowColor rgba(0,0,0,0.4) at shadowOpacity 0.3, radius 12, y 4
        boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
      },
    },
    interactive: {
      true: {
        cursor: 'pointer',
        backgroundColor: 'hover:borderColor press:backgroundPress',
        borderColor: 'hover:placeholderColor press:primary',
        opacity: { press: 0.95 },
      },
    },
    variant: {
      default: {},
      outline: {
        backgroundColor: 'transparent',
        borderColor: 'borderColor',
      },
      ghost: {
        backgroundColor: 'transparent',
        borderWidth: 0,
      },
      highlight: {
        borderColor: 'primary',
        borderWidth: 2,
      },
    },
  } as const,

  defaultVariants: {
    variant: 'default',
  },
})

export const CardHeader = styled(CardHeaderBehavior, {
  name: 'CardHeader',
  paddingBottom: '3',
  borderBottomWidth: 1,
  borderBottomColor: 'borderColor',
  marginBottom: '3',
})

export const CardFooter = styled(CardFooterBehavior, {
  name: 'CardFooter',
  paddingTop: '3',
  borderTopWidth: 1,
  borderTopColor: 'borderColor',
  marginTop: '3',
})

export type CardProps = GetProps<typeof Card>
