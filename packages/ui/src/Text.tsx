import { type GetProps, styled, Text as TamaguiText } from 'tamagui'

export const Text = styled(TamaguiText, {
  name: 'Text',
  fontFamily: '$body',
  // Default to Bondfire whiteSmoke for text
  color: '$gray12',

  variants: {
    variant: {
      heading: {
        fontFamily: '$heading',
        fontWeight: '700',
        color: '$gray12',
      },
      subheading: {
        fontFamily: '$heading',
        fontWeight: '600',
        fontSize: '$4',
        color: '$gray12',
      },
      body: {
        fontFamily: '$body',
        color: '$gray12',
      },
      label: {
        fontFamily: '$body',
        fontWeight: '600',
        fontSize: 14,
        color: '$gray12',
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
