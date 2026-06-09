import { type GetProps, styled, Text as TamaguiText } from 'tamagui'

export const Text = styled(TamaguiText, {
  name: 'Text',
  fontFamily: '$body',
  // Default to Bondfire whiteSmoke for text
  color: '$color',

  variants: {
    variant: {
      heading: {
        fontFamily: '$heading',
        fontWeight: '700',
        color: '$color',
      },
      subheading: {
        fontFamily: '$heading',
        fontWeight: '600',
        fontSize: '$4',
        color: '$color',
      },
      body: {
        fontFamily: '$body',
        color: '$color',
      },
      label: {
        fontFamily: '$body',
        fontWeight: '600',
        fontSize: 14,
        color: '$color',
      },
      caption: {
        fontFamily: '$body',
        fontSize: 12,
        color: '$placeholderColor',
      },
      link: {
        fontFamily: '$body',
        color: '$primary',
        textDecorationLine: 'underline',
      },
    },
    muted: {
      true: {
        color: '$placeholderColor',
      },
    },
    center: {
      true: {
        textAlign: 'center',
      },
    },
    bold: {
      true: {
        fontWeight: '700',
      },
    },
    accent: {
      true: {
        color: '$primary',
      },
    },
  } as const,

  defaultVariants: {
    variant: 'body',
  },
})

export type TextProps = GetProps<typeof Text>
