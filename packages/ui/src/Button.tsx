import { styled, Button as TamaguiButton, GetProps } from 'tamagui'

export const Button = styled(TamaguiButton, {
  name: 'Button',
  fontFamily: '$body',
  
  variants: {
    variant: {
      primary: {
        backgroundColor: '$orange10',
        color: '$white',
        hoverStyle: {
          backgroundColor: '$orange11',
        },
        pressStyle: {
          backgroundColor: '$orange9',
        },
      },
      secondary: {
        backgroundColor: '$gray4',
        color: '$gray12',
        hoverStyle: {
          backgroundColor: '$gray5',
        },
        pressStyle: {
          backgroundColor: '$gray3',
        },
      },
      outline: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: '$gray8',
        color: '$gray12',
        hoverStyle: {
          backgroundColor: '$gray2',
        },
        pressStyle: {
          backgroundColor: '$gray3',
        },
      },
      ghost: {
        backgroundColor: 'transparent',
        color: '$gray12',
        hoverStyle: {
          backgroundColor: '$gray3',
        },
        pressStyle: {
          backgroundColor: '$gray4',
        },
      },
    },
    size: {
      sm: {
        height: 36,
        paddingHorizontal: '$3',
        fontSize: '$2',
      },
      md: {
        height: 44,
        paddingHorizontal: '$4',
        fontSize: '$3',
      },
      lg: {
        height: 52,
        paddingHorizontal: '$5',
        fontSize: '$4',
      },
    },
  } as const,

  defaultVariants: {
    variant: 'primary',
    size: 'md',
  },
})

export type ButtonProps = GetProps<typeof Button>

