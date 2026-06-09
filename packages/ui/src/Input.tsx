import { type GetProps, styled, Input as TamaguiInput, TextArea as TamaguiTextArea } from 'tamagui'

export const Input = styled(TamaguiInput, {
  name: 'Input',
  fontFamily: '$body',
  // Bondfire styling - gunmetal background with iron border
  backgroundColor: '$backgroundHover',
  color: '$gray12',
  placeholderTextColor: '$placeholderColor',
  borderWidth: 1,
  borderColor: '$borderColor',
  borderRadius: 12,
  paddingHorizontal: 16,
  height: 44,

  focusStyle: {
    borderColor: '$primary',
    borderWidth: 2,
  },

  variants: {
    error: {
      true: {
        borderColor: '$error',
        focusStyle: {
          borderColor: '$error',
        },
      },
    },
    // Use $-prefixed size tokens to match Tamagui's token format
    size: {
      $sm: {
        height: 36,
        fontSize: 14,
        paddingHorizontal: 12,
      },
      $md: {
        height: 44,
        fontSize: 15,
        paddingHorizontal: 16,
      },
      $lg: {
        height: 52,
        fontSize: 16,
        paddingHorizontal: 20,
      },
    },
  } as const,

  defaultVariants: {
    size: '$md',
  },
})

export const TextArea = styled(TamaguiTextArea, {
  name: 'TextArea',
  fontFamily: '$body',
  // Bondfire styling
  backgroundColor: '$backgroundHover',
  color: '$gray12',
  placeholderTextColor: '$placeholderColor',
  borderWidth: 1,
  borderColor: '$borderColor',
  borderRadius: 12,
  padding: 16,
  minHeight: 100,

  focusStyle: {
    borderColor: '$primary',
    borderWidth: 2,
  },

  variants: {
    error: {
      true: {
        borderColor: '$error',
      },
    },
  } as const,
})

export type InputProps = GetProps<typeof Input>
export type TextAreaProps = GetProps<typeof TextArea>
