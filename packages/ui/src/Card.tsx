import { type GetProps, Card as TamaguiCard, styled } from 'tamagui'

export const Card = styled(TamaguiCard, {
  name: 'Card',
  backgroundColor: '$background',
  borderRadius: '$4',
  padding: '$4',
  borderWidth: 1,
  borderColor: '$borderColor',

  variants: {
    elevated: {
      true: {
        shadowColor: '$shadowColor',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 4,
      },
    },
    interactive: {
      true: {
        cursor: 'pointer',
        hoverStyle: {
          backgroundColor: '$backgroundHover',
        },
        pressStyle: {
          backgroundColor: '$backgroundPress',
        },
      },
    },
  } as const,
})

export const CardHeader = styled(TamaguiCard.Header, {
  name: 'CardHeader',
  paddingBottom: '$2',
})

export const CardFooter = styled(TamaguiCard.Footer, {
  name: 'CardFooter',
  paddingTop: '$2',
})

export type CardProps = GetProps<typeof Card>
