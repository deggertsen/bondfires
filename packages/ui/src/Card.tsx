import { type GetProps, Card as TamaguiCard, styled } from 'tamagui'
import { bondfireColors } from '@bondfires/config'

export const Card = styled(TamaguiCard, {
  name: 'Card',
  // Use Bondfire gunmetal for card background
  backgroundColor: bondfireColors.gunmetal,
  borderRadius: 12,
  padding: '$4',
  borderWidth: 1,
  borderColor: bondfireColors.iron,
  overflow: 'hidden',

  variants: {
    elevated: {
      true: {
        shadowColor: 'rgba(0, 0, 0, 0.4)',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 6,
      },
    },
    interactive: {
      true: {
        cursor: 'pointer',
        hoverStyle: {
          backgroundColor: bondfireColors.iron,
          borderColor: bondfireColors.ash,
        },
        pressStyle: {
          backgroundColor: bondfireColors.charcoal,
          borderColor: bondfireColors.bondfireCopper,
          opacity: 0.95,
        },
      },
    },
    variant: {
      default: {},
      outline: {
        backgroundColor: 'transparent',
        borderColor: bondfireColors.iron,
      },
      ghost: {
        backgroundColor: 'transparent',
        borderWidth: 0,
      },
      highlight: {
        borderColor: bondfireColors.bondfireCopper,
        borderWidth: 2,
      },
    },
  } as const,

  defaultVariants: {
    variant: 'default',
  },
})

export const CardHeader = styled(TamaguiCard.Header, {
  name: 'CardHeader',
  paddingBottom: '$3',
  borderBottomWidth: 1,
  borderBottomColor: bondfireColors.iron,
  marginBottom: '$3',
})

export const CardFooter = styled(TamaguiCard.Footer, {
  name: 'CardFooter',
  paddingTop: '$3',
  borderTopWidth: 1,
  borderTopColor: bondfireColors.iron,
  marginTop: '$3',
})

export type CardProps = GetProps<typeof Card>
