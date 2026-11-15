import { type GetProps, styled, Button as TamaguiButton } from 'tamagui'

const ButtonFrame = styled(TamaguiButton, {
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
      // Filled variants render under the `onPrimary` sub-theme (see Button
      // below), so labels/icons that use `$color` come out white. The darker
      // `*Solid` fills keep that white label above WCAG AA in both themes.
      primary: {
        backgroundColor: '$primarySolid',
        color: '$colorOnPrimary',
        hoverStyle: {
          backgroundColor: '$primarySolidHover',
        },
        pressStyle: {
          backgroundColor: '$primarySolidPress',
        },
      },
      secondary: {
        backgroundColor: '$backgroundHover',
        color: '$color',
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
        color: '$color',
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
        color: '$color',
        hoverStyle: {
          backgroundColor: '$backgroundHover',
        },
        pressStyle: {
          backgroundColor: '$borderColor',
        },
      },
      destructive: {
        backgroundColor: '$errorSolid',
        color: '$colorOnError',
        hoverStyle: {
          backgroundColor: '$errorSolidPress',
        },
        pressStyle: {
          backgroundColor: '$errorSolidPress',
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

const FILLED_VARIANTS = new Set(['primary', 'destructive'])

/**
 * Filled variants (primary, destructive) sit on a dark fill, so their content
 * needs a light foreground in both themes. Rendering them under the
 * `onPrimary` sub-theme remaps `$color` to `$colorOnPrimary` for every
 * descendant, so call sites can keep writing `<Text color="$color">`.
 */
export const Button = ButtonFrame.styleable((props, ref) => {
  const filled = FILLED_VARIANTS.has(props.variant ?? 'primary')
  return <ButtonFrame ref={ref} theme={filled ? 'onPrimary' : undefined} {...props} />
})

export type ButtonProps = GetProps<typeof Button>
