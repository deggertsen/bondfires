import { type GetProps, Button as TamaguiButton, styled } from 'tamagui'
import { bondfireColors } from '@bondfires/config'

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
        backgroundColor: bondfireColors.bondfireCopper,
        color: bondfireColors.whiteSmoke,
        hoverStyle: {
          backgroundColor: bondfireColors.moltenGold,
        },
        pressStyle: {
          backgroundColor: bondfireColors.deepEmber,
          opacity: 0.9,
        },
      },
      secondary: {
        backgroundColor: bondfireColors.gunmetal,
        color: bondfireColors.whiteSmoke,
        hoverStyle: {
          backgroundColor: bondfireColors.iron,
        },
        pressStyle: {
          backgroundColor: bondfireColors.charcoal,
          opacity: 0.9,
        },
      },
      outline: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: bondfireColors.iron,
        color: '$color',
        hoverStyle: {
          backgroundColor: bondfireColors.gunmetal,
          borderColor: bondfireColors.ash,
        },
        pressStyle: {
          backgroundColor: bondfireColors.charcoal,
          borderColor: bondfireColors.bondfireCopper,
        },
      },
      ghost: {
        backgroundColor: 'transparent',
        color: '$color',
        hoverStyle: {
          backgroundColor: bondfireColors.gunmetal,
        },
        pressStyle: {
          backgroundColor: bondfireColors.iron,
        },
      },
      destructive: {
        backgroundColor: bondfireColors.error,
        color: bondfireColors.whiteSmoke,
        hoverStyle: {
          backgroundColor: bondfireColors.errorDark,
        },
        pressStyle: {
          backgroundColor: bondfireColors.errorDark,
          opacity: 0.9,
        },
      },
    },
    // Use $-prefixed size tokens to match Tamagui's token format
    size: {
      '$sm': {
        height: 36,
        paddingHorizontal: 16,
        fontSize: 14,
        fontFamily: '$body',
        gap: 6,
      },
      '$md': {
        height: 44,
        paddingHorizontal: 20,
        fontSize: 15,
        fontFamily: '$body',
        gap: 8,
      },
      '$lg': {
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
