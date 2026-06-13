import { Platform } from 'react-native'
import { type GetProps, styled, Input as TamaguiInput, TextArea as TamaguiTextArea } from 'tamagui'

type TamaguiInputProps = GetProps<typeof TamaguiInput>
type AutoCompleteValue = NonNullable<TamaguiInputProps['autoComplete']>
type TextContentTypeValue = TamaguiInputProps['textContentType']

/**
 * Maps a React Native `autoComplete` value to the matching iOS `textContentType`.
 */
function autoCompleteToTextContentType(
  autoComplete: AutoCompleteValue | undefined,
): TextContentTypeValue {
  switch (autoComplete) {
    case 'current-password':
    case 'password':
      return 'password'
    case 'new-password':
    case 'password-new':
      return 'newPassword'
    case 'email':
      return 'emailAddress'
    case 'username':
      return 'username'
    case 'tel':
      return 'telephoneNumber'
    case 'url':
      return 'URL'
    case 'one-time-code':
      return 'oneTimeCode'
    default:
      return undefined
  }
}

/**
 * React Native 0.81 documents `current-password` / `new-password`, but the
 * Android native map still expects `password` / `password-new`. Passing an
 * unmapped value makes RN mark the native view as not important for autofill.
 */
function resolveAndroidAutoComplete(
  autoComplete: AutoCompleteValue | undefined,
): AutoCompleteValue | undefined {
  switch (autoComplete) {
    case 'current-password':
      return 'password'
    case 'new-password':
      return 'password-new'
    default:
      return autoComplete
  }
}

const StyledInput = styled(TamaguiInput, {
  name: 'Input',
  fontFamily: '$body',
  // Bondfire styling - gunmetal background with iron border
  backgroundColor: '$backgroundHover',
  color: '$color',
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

/**
 * Bondfires-themed TextInput. Accepts all React Native `TextInput` props,
 * including `autoComplete` and `secureTextEntry`. The component normalizes
 * platform-specific password-manager hints so callers can use React Native's
 * documented `current-password` / `new-password` values:
 *
 * - iOS: derives `textContentType` from `autoComplete` (iOS keychain/password
 *   managers key off this), and omits `autoComplete` for values it maps so we
 *   do not pass overlapping semantic props.
 * - Android: maps RN's documented password values to the Android values that
 *   RN 0.81.5 actually forwards to `setAutofillHints`.
 *
 * Callers can override by passing `textContentType` directly (iOS only).
 */
export const Input = StyledInput.styleable<InputProps>((props, ref) => {
  const { autoComplete, secureTextEntry, textContentType, importantForAutofill, ...rest } = props

  const resolvedTextContentType =
    Platform.OS === 'ios'
      ? (textContentType ?? autoCompleteToTextContentType(autoComplete))
      : undefined

  const resolvedAutoComplete =
    Platform.OS === 'android'
      ? resolveAndroidAutoComplete(autoComplete)
      : Platform.OS === 'ios' && resolvedTextContentType !== undefined
        ? undefined
        : autoComplete

  const resolvedImportantForAutofill =
    Platform.OS === 'android' && secureTextEntry && importantForAutofill === undefined
      ? 'yes'
      : importantForAutofill

  return (
    <StyledInput
      ref={ref}
      secureTextEntry={secureTextEntry}
      {...(resolvedAutoComplete === undefined ? {} : { autoComplete: resolvedAutoComplete })}
      {...(resolvedTextContentType === undefined
        ? {}
        : { textContentType: resolvedTextContentType })}
      {...(resolvedImportantForAutofill === undefined
        ? {}
        : { importantForAutofill: resolvedImportantForAutofill })}
      {...rest}
    />
  )
})

export const TextArea = styled(TamaguiTextArea, {
  name: 'TextArea',
  fontFamily: '$body',
  // Bondfire styling
  backgroundColor: '$backgroundHover',
  color: '$color',
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

export type InputProps = TamaguiInputProps
export type TextAreaProps = GetProps<typeof TamaguiTextArea>
