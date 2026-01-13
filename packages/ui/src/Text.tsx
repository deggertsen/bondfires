import { type GetProps, Text as TamaguiText, styled } from 'tamagui'
import { bondfireColors } from '@bondfires/config'

export const Text = styled(TamaguiText, {
  name: 'Text',
  fontFamily: '$body',
  // Default to Bondfire whiteSmoke for text
  color: bondfireColors.whiteSmoke,

  variants: {
    variant: {
      heading: {
        fontFamily: '$heading',
        fontWeight: '700',
        color: bondfireColors.whiteSmoke,
      },
      subheading: {
        fontFamily: '$heading',
        fontWeight: '600',
        fontSize: '$4',
        color: bondfireColors.whiteSmoke,
      },
      body: {
        fontFamily: '$body',
        color: bondfireColors.whiteSmoke,
      },
      label: {
        fontFamily: '$body',
        fontWeight: '600',
        fontSize: 14,
        color: bondfireColors.whiteSmoke,
      },
      caption: {
        fontFamily: '$body',
        fontSize: 12,
        color: bondfireColors.ash,
      },
      link: {
        fontFamily: '$body',
        color: bondfireColors.bondfireCopper,
        textDecorationLine: 'underline',
      },
    },
    muted: {
      true: {
        color: bondfireColors.ash,
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
        color: bondfireColors.bondfireCopper,
      },
    },
  } as const,

  defaultVariants: {
    variant: 'body',
  },
})

export type TextProps = GetProps<typeof Text>
