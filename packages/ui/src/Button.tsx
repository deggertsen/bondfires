import { createStyledHOC, type GetProps, styled } from 'tamagui'
import {
  ButtonFrame as ButtonBehaviorFrame,
  type ButtonBehaviorProps,
  ButtonText as ButtonBehaviorText,
  textParentInlineProps,
  useButton,
} from 'tamagui/unstyled'

type ButtonSize = 'sm' | 'md' | 'lg'

// Icon px per size, matching the font-size tokens Tamagui v1 sized button icons
// from (body font sm/md/lg).
const ICON_SIZE: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 18 }

// Built on Tamagui's unstyled button behavior (the v3 replacement for
// `styled(Button, { unstyled: true })`): the default skin's size ladder, radius
// and level2 theme would otherwise sit under these styles.
const ButtonFrame = styled(ButtonBehaviorFrame, {
  name: 'Button',
  // Base button styles matching Flutter FilledButton
  alignItems: 'center',
  justifyContent: 'center',
  flexDirection: 'row',
  borderRadius: 24,
  cursor: 'pointer',

  variants: {
    variant: {
      // Filled variants render under the `onPrimary` sub-theme (see Button
      // below), so labels/icons that use `color` come out white. The darker
      // `*Solid` fills keep that white label above WCAG AA in both themes.
      primary: {
        backgroundColor: 'primarySolid hover:primarySolidHover press:primarySolidPress',
      },
      secondary: {
        backgroundColor: 'backgroundHover hover:borderColor press:backgroundPress',
        opacity: { press: 0.9 },
      },
      outline: {
        backgroundColor: 'transparent hover:backgroundHover press:backgroundPress',
        borderWidth: 1,
        borderColor: 'borderColor hover:placeholderColor press:primary',
      },
      ghost: {
        backgroundColor: 'transparent hover:backgroundHover press:borderColor',
      },
      destructive: {
        backgroundColor: 'errorSolid hover:errorSolidPress press:errorSolidPress',
      },
    },
    size: {
      sm: {
        height: 36,
        paddingHorizontal: 16,
        gap: 6,
      },
      md: {
        height: 44,
        paddingHorizontal: 20,
        gap: 8,
      },
      lg: {
        height: 52,
        paddingHorizontal: 24,
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
    size: 'md',
  },
})

const ButtonLabel = styled(ButtonBehaviorText, {
  name: 'ButtonText',
  fontFamily: 'body',
  fontWeight: '600',
  color: 'color',

  variants: {
    size: {
      sm: { fontSize: 14 },
      md: { fontSize: 15 },
      lg: { fontSize: 16 },
    },
  } as const,

  defaultVariants: {
    size: 'md',
  },
})

type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive'

const FILLED_VARIANTS = new Set<ButtonVariant>(['primary', 'destructive'])

/**
 * Filled variants (primary, destructive) sit on a dark fill, so their content
 * needs a light foreground in both themes. Rendering them under the
 * `onPrimary` sub-theme remaps `color` to `colorOnPrimary` for every
 * descendant, so call sites can keep writing `<Text color="color">`.
 */
export const Button = createStyledHOC(
  ButtonFrame,
  function Button(
    props: ButtonBehaviorProps & { size?: ButtonSize | null; variant?: ButtonVariant | null },
    ref,
  ) {
    const size: ButtonSize = props.size ?? 'md'
    const filled = FILLED_VARIANTS.has(props.variant ?? 'primary')
    const { props: buttonProps } = useButton(props, {
      Text: ButtonLabel,
      textProps: { size },
      iconSize: ICON_SIZE[size],
      iconColor: typeof props.color === 'string' ? props.color : 'color',
    })
    return (
      <ButtonFrame
        ref={ref}
        theme={filled ? 'onPrimary' : undefined}
        {...(buttonProps as GetProps<typeof ButtonFrame>)}
      />
    )
  },
  // Text style props (color, fontSize, ...) pass through to the label.
  { staticConfig: { inlineProps: textParentInlineProps } },
)

export type ButtonProps = GetProps<typeof Button>
