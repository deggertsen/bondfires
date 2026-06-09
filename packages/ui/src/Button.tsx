import { type GetProps, styled, Button as TamaguiButton } from 'tamagui'

export const Button = styled(TamaguiButton, {
  name: 'Button',
  // Disable TamaguiButton's default size-to-font mapping to prevent warnings
  unstyled: true,
  // Base button styles matching Flutter FilledButton
  alignItems: 'center',
  justifyContent: 'center',
  flexDirection: 'row',
  borderRadius: 24,
  cursor: 'pointer',
  fontWeight: '600',

  variants: {
    variant: {
      primary: {
        backgroundColor: '$primary',
        color: '$gray12',
        hoverStyle: {
          backgroundColor: '$secondary',
        },
        pressStyle: {
          backgroundColor: '$primaryPress',
          opacity: 0.9,
        },
      },
      secondary: {
        backgroundColor: '$backgroundHover',
        color: '$gray12',
        hoverStyle: {
          backgroundColor: '$borderColor',
        },
        pressStyle: {
          backgroundColor: '$backgroundPress',
          opacity: 0.9,
        },
      },
      outline: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: '$borderColor',
        color: '$gray12',
        hoverStyle: {
          backgroundColor: '$backgroundHover',
          borderColor: '$placeholderColor',
        },
        pressStyle: {
          backgroundColor: '$backgroundPress',
          borderColor: '$primary',
        },
      },
      ghost: {
        backgroundColor: 'transparent',
        color: '$gray12',
        hoverStyle: {
          backgroundColor: '$backgroundHover',
        },
        pressStyle: {
          backgroundColor: '$borderColor',
        },
      },
      destructive: {
        backgroundColor: '$error',
        color: '$gray12',
        hoverStyle: {
          backgroundColor: '$error',
        },
        pressStyle: {
          backgroundColor: '$error',
          opacity: 0.9,
        },
      },
    },
    // Use $-prefixed size tokens to match Tamagui's token format
    size: {
      $sm: {
        height: 36,
        paddingHorizontal: 16,
        fontSize: 14,
        fontFamily: '$body',
        gap: 6,
      },
      $md: {
        height: 44,
        paddingHorizontal: 20,
        fontSize: 15,
        fontFamily: '$body',
        gap: 8,
      },
      $lg: {
        height: 52,
        paddingHorizontal: 24,
        fontSize: 16,
        fontFamily: '$body',
        gap: 10,
      },
    },
    disabled: {
      true: {
        opacity: 0.5,
        pointerEvents: 'none',
      },
    },
  } as const,

  defaultVariants: {
    variant: 'primary',
    size: '$md',
  },
})

export type ButtonProps = GetProps<typeof Button>
