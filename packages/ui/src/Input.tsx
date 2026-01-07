import { styled, Input as TamaguiInput, TextArea as TamaguiTextArea, GetProps } from 'tamagui'

export const Input = styled(TamaguiInput, {
  name: 'Input',
  fontFamily: '$body',
  backgroundColor: '$background',
  borderWidth: 1,
  borderColor: '$borderColor',
  borderRadius: '$3',
  paddingHorizontal: '$3',
  height: 44,
  
  focusStyle: {
    borderColor: '$orange8',
    outlineColor: '$orange8',
    outlineWidth: 2,
    outlineStyle: 'solid',
  },
  
  variants: {
    error: {
      true: {
        borderColor: '$red10',
        focusStyle: {
          borderColor: '$red10',
          outlineColor: '$red8',
        },
      },
    },
    size: {
      sm: {
        height: 36,
        fontSize: '$2',
      },
      md: {
        height: 44,
        fontSize: '$3',
      },
      lg: {
        height: 52,
        fontSize: '$4',
      },
    },
  } as const,

  defaultVariants: {
    size: 'md',
  },
})

export const TextArea = styled(TamaguiTextArea, {
  name: 'TextArea',
  fontFamily: '$body',
  backgroundColor: '$background',
  borderWidth: 1,
  borderColor: '$borderColor',
  borderRadius: '$3',
  padding: '$3',
  minHeight: 100,
  
  focusStyle: {
    borderColor: '$orange8',
    outlineColor: '$orange8',
    outlineWidth: 2,
    outlineStyle: 'solid',
  },
  
  variants: {
    error: {
      true: {
        borderColor: '$red10',
      },
    },
  } as const,
})

export type InputProps = GetProps<typeof Input>
export type TextAreaProps = GetProps<typeof TextArea>

