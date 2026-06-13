import { type GetProps, styled, Input as TamaguiInput, TextArea as TamaguiTextArea } from 'tamagui'
import { Platform } from 'react-native'

/**
 * Maps a React Native `autoComplete` value to the matching iOS `textContentType`.
 *
 * Why we need this: iOS password managers (iCloud Keychain, 1Password, Bitwarden,
 * etc.) key off `textContentType` to surface strong-password / credential
 * suggestions. `autoComplete` is the Android/web hint and is not enough on iOS
 * to trigger password manager detection. Setting both covers both platforms.
 *
 * Reference: https://reactnative.dev/docs/textinput#textcontenttype
 */
function autoCompleteToTextContentType(
  autoComplete: string | undefined,
): GetProps<typeof TamaguiInput>['textContentType'] {
  switch (autoComplete) {
    case 'password':
      return 'password'
    case 'new-password':
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
 * On Android, `autoComplete="password"` and `autoComplete="new-password"`
 * are NOT in React Native's `REACT_PROPS_AUTOFILL_HINTS_MAP` (verified in
 * react-native 0.81.5, ReactTextInputManager.kt). When passed, RN's
 * `setTextContentType` falls into the `else` branch and sets
 * `importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO` — which explicitly
 * disables Android's Autofill Framework for that field. Result: 1Password,
 * Bitwarden, Google Password Manager, etc. can't see the field.
 *
 * We work around this on Android by:
 * 1. Stripping the unsupported `autoComplete` values (so RN doesn't disable
 *    autofill on us), and
 * 2. Forcing `importantForAutofill="yes"` to override the default `auto`
 *    (defense in depth — some password managers also check this).
 *
 * The `secureTextEntry` prop still sets `inputType=password` on the
 * underlying `EditText`, which the Android Autofill Framework recognizes
 * heuristically. Combined with `autofillHints` not being explicitly
 * suppressed, password managers (1Password, Bitwarden, LastPass, Google's)
 * will surface suggestions.
 *
 * See: https://github.com/facebook/react-native/issues/37236
 *      (search ReactTextInputManager.kt for `REACT_PROPS_AUTOFILL_HINTS_MAP`)
 */
const ANDROID_UNSUPPORTED_AUTOCOMPLETE = new Set(['password', 'new-password'])

type AutoCompleteValue = NonNullable<GetProps<typeof TamaguiInput>['autoComplete']>

function resolveAndroidAutoComplete(
  autoComplete: AutoCompleteValue | undefined,
): AutoCompleteValue | undefined {
  if (autoComplete && ANDROID_UNSUPPORTED_AUTOCOMPLETE.has(autoComplete)) {
    return undefined
  }
  return autoComplete
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
 * including `autoComplete` and `secureTextEntry`. The component handles
 * platform-specific password-manager behavior so callers can pass
 * `autoComplete="password"` and get correct behavior on both iOS and Android:
 *
 * - iOS: derives `textContentType` from `autoComplete` (iOS keychain/password
 *   managers key off this).
 * - Android: strips the values that would trip RN 0.81's
 *   `IMPORTANT_FOR_AUTOFILL_NO` bug, and forces `importantForAutofill="yes"`.
 *
 * Callers can override by passing `textContentType` directly (iOS only).
 */
export const Input = StyledInput.styleable<InputProps>((props, ref) => {
  const {
    autoComplete,
    secureTextEntry,
    textContentType,
    importantForAutofill,
    ...rest
  } = props

  const resolvedTextContentType =
    Platform.OS === 'ios'
      ? (textContentType ?? autoCompleteToTextContentType(autoComplete))
      : undefined

  // On Android, strip `autoComplete` values that trigger RN's autofill-disable
  // bug. For other values (email, username, tel, name-*, etc.) pass through
  // unchanged — those are in RN's REACT_PROPS_AUTOFILL_HINTS_MAP and work.
  const resolvedAutoComplete =
    Platform.OS === 'android' ? resolveAndroidAutoComplete(autoComplete) : autoComplete

  // On Android, force `importantForAutofill="yes"` for fields that are
  // semantically sensitive (password-like). This overrides RN's default
  // (AUTO) defensively in case any future code path sets NO. We only do this
  // when secureTextEntry is on, to avoid affecting non-sensitive fields.
  const resolvedImportantForAutofill =
    Platform.OS === 'android' && secureTextEntry && importantForAutofill === undefined
      ? 'yes'
      : importantForAutofill

  return (
    <StyledInput
      ref={ref}
      autoComplete={resolvedAutoComplete}
      secureTextEntry={secureTextEntry}
      textContentType={resolvedTextContentType}
      importantForAutofill={resolvedImportantForAutofill}
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

export type InputProps = GetProps<typeof TamaguiInput>
export type TextAreaProps = GetProps<typeof TamaguiTextArea>
