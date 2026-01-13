import { type GetProps, Input as TamaguiInput, TextArea as TamaguiTextArea, styled } from 'tamagui'
import { bondfireColors } from '@bondfires/config'

export const Input = styled(TamaguiInput, {
  name: 'Input',
  fontFamily: '$body',
  // Bondfire styling - gunmetal background with iron border
  backgroundColor: bondfireColors.gunmetal,
  color: bondfireColors.whiteSmoke,
  placeholderTextColor: bondfireColors.ash,
  borderWidth: 1,
  borderColor: bondfireColors.iron,
  borderRadius: 12,
  paddingHorizontal: 16,
  height: 44,

  focusStyle: {
    borderColor: bondfireColors.bondfireCopper,
    borderWidth: 2,
  },

  variants: {
    error: {
      true: {
        borderColor: bondfireColors.error,
        focusStyle: {
          borderColor: bondfireColors.error,
        },
      },
    },
    // Use $-prefixed size tokens to match Tamagui's token format
    size: {
      '$sm': {
        height: 36,
        fontSize: 14,
        paddingHorizontal: 12,
      },
      '$md': {
        height: 44,
        fontSize: 15,
        paddingHorizontal: 16,
      },
      '$lg': {
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
  backgroundColor: bondfireColors.gunmetal,
  color: bondfireColors.whiteSmoke,
  placeholderTextColor: bondfireColors.ash,
  borderWidth: 1,
  borderColor: bondfireColors.iron,
  borderRadius: 12,
  padding: 16,
  minHeight: 100,

  focusStyle: {
    borderColor: bondfireColors.bondfireCopper,
    borderWidth: 2,
  },

  variants: {
    error: {
      true: {
        borderColor: bondfireColors.error,
      },
    },
  } as const,
})

export type InputProps = GetProps<typeof Input>
export type TextAreaProps = GetProps<typeof TextArea>
