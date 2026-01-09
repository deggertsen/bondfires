import { type GetProps, Text as TamaguiText, styled } from 'tamagui'

export const Text = styled(TamaguiText, {
  name: 'Text',
  fontFamily: '$body',
  color: '$color',

  variants: {
    variant: {
      heading: {
        fontFamily: '$heading',
        fontWeight: '700',
      },
      body: {
        fontFamily: '$body',
      },
      label: {
        fontFamily: '$body',
        fontWeight: '600',
        fontSize: '$2',
      },
      caption: {
        fontFamily: '$body',
        fontSize: '$1',
        color: '$gray11',
      },
    },
    muted: {
      true: {
        color: '$gray11',
      },
    },
    center: {
      true: {
        textAlign: 'center',
      },
    },
  } as const,

  defaultVariants: {
    variant: 'body',
  },
})

export type TextProps = GetProps<typeof Text>
