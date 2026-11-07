import { getAuthErrorMessage, useSystemThemeColors } from '@bondfires/app'
import { Button, Input, Spinner, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { useObservable, useValue } from '@legendapp/state/react'
import { CheckSquare, Flame, ShieldCheck, Square, UserPlus } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef } from 'react'
import { Alert, Linking, Pressable, StatusBar } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import { type DeviceAgeRange, parseBirthMonth } from '../../../convex/agePolicy'
import { requestDeviceAgeRange } from '../lib/deviceAgeRange'
import {
  birthMonthFromControls,
  decideRegistrationAgeStep,
  type RegistrationAgeStep,
} from '../lib/deviceAgeSignal'
import { routes } from '../lib/routes'
import { clearRegistrationDestination, registrationDestination } from '../lib/socialAuth'

type Gender = 'male' | 'female' | 'other'

const GENDER_OPTIONS: Array<{ value: Gender; label: string }> = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
]

const MONTH_OPTIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/** Either the phone's range or the typed month, never both and never a full date. */
type AgeInput = { deviceAgeRange: DeviceAgeRange } | { birthMonth: string }

export function RegistrationForm({ completing = false }: { completing?: boolean }) {
  const { colors, statusBarStyle } = useSystemThemeColors()
  const router = useRouter()
  const { redirectTo } = useLocalSearchParams<{ redirectTo?: string }>()
  const { signIn, signOut } = useAuthActions()
  const status = useQuery(api.registration.status, completing ? {} : 'skip')
  const complete = useMutation(api.registration.complete)
  const deleteAccount = useMutation(api.accountDeletion.request)
  const initialized = useRef(false)
  const deviceAsked = useRef(false)

  const form$ = useObservable({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
    gender: null as Gender | null,
    // Phone-first age: ask the device before showing any age field.
    ageStep: 'checking' as 'checking' | RegistrationAgeStep,
    deviceAgeRange: null as DeviceAgeRange | null,
    // Month/year fallback controls start unset on purpose.
    birthMonthIndex: null as number | null,
    birthYear: '',
    isLoading: false,
    error: null as string | null,
    acceptedLegal: false,
  })

  const firstName = useValue(form$.firstName)
  const lastName = useValue(form$.lastName)
  const email = useValue(form$.email)
  const password = useValue(form$.password)
  const confirmPassword = useValue(form$.confirmPassword)
  const gender = useValue(form$.gender)
  const ageStep = useValue(form$.ageStep)
  const birthMonthIndex = useValue(form$.birthMonthIndex)
  const birthYear = useValue(form$.birthYear)
  const isLoading = useValue(form$.isLoading)
  const error = useValue(form$.error)
  const acceptedLegal = useValue(form$.acceptedLegal)

  useEffect(() => {
    if (!completing || !status || initialized.current) return
    initialized.current = true
    form$.firstName.set(status.firstName)
    form$.lastName.set(status.lastName)
    form$.email.set(status.email)
  }, [completing, status, form$])

  // One device request per form. Any failure resolves to "ask" (month/year).
  useEffect(() => {
    if (deviceAsked.current) return
    deviceAsked.current = true
    let cancelled = false
    requestDeviceAgeRange().then((range) => {
      if (cancelled) return
      form$.deviceAgeRange.set(range)
      form$.ageStep.set(decideRegistrationAgeStep(range))
    })
    return () => {
      cancelled = true
    }
  }, [form$])

  const destination = redirectTo ?? registrationDestination()
  if (completing && status === undefined)
    return (
      <YStack flex={1} backgroundColor="$background" justifyContent="center" alignItems="center">
        <Spinner />
      </YStack>
    )
  if (completing && status === null) return <Redirect href={routes.login(destination)} />
  if (completing && status?.ageBlocked) return <Redirect href={routes.ageBlocked} />
  if (completing && status && !status.pending) return <Redirect href={routes.splash(destination)} />

  const resolveAgeInput = (): AgeInput | null => {
    const step = form$.ageStep.get()
    const range = form$.deviceAgeRange.get()
    if ((step === 'teen' || step === 'adult') && range) return { deviceAgeRange: range }
    if (step !== 'ask') return null
    const birthMonth = birthMonthFromControls(form$.birthMonthIndex.get(), form$.birthYear.get())
    return birthMonth && parseBirthMonth(birthMonth) ? { birthMonth } : null
  }

  const handleSignup = async () => {
    const currentFirstName = form$.firstName.get().trim()
    const currentLastName = form$.lastName.get().trim()
    const currentEmail = form$.email.get().trim()
    const currentPassword = form$.password.get()
    const currentConfirmPassword = form$.confirmPassword.get()
    const currentGender = form$.gender.get()
    const currentAcceptedLegal = form$.acceptedLegal.get()
    const currentStep = form$.ageStep.get()

    if (currentStep === 'checking' || currentStep === 'blocked') return

    if (
      !currentFirstName ||
      !currentLastName ||
      (!completing && (!currentEmail || !currentPassword)) ||
      !currentGender
    ) {
      form$.error.set('Please fill in all fields')
      return
    }

    const ageInput = resolveAgeInput()
    if (!ageInput) {
      form$.error.set('Please select your birth month and enter your birth year.')
      return
    }

    if (!completing && currentPassword !== currentConfirmPassword) {
      form$.error.set('Passwords do not match')
      return
    }

    if (!completing && currentPassword.length < 8) {
      form$.error.set('Password must be at least 8 characters')
      return
    }
    if (!currentAcceptedLegal) {
      form$.error.set('You must accept the Terms and Community Guidelines')
      return
    }

    form$.isLoading.set(true)
    form$.error.set(null)

    try {
      if (completing) {
        await complete({
          firstName: currentFirstName,
          lastName: currentLastName,
          gender: currentGender,
          ...ageInput,
          acceptedLegal: currentAcceptedLegal,
        })
        router.replace(routes.splash(destination))
        return
      }
      await signIn('password', {
        email: currentEmail,
        password: currentPassword,
        firstName: currentFirstName,
        lastName: currentLastName,
        gender: currentGender,
        flow: 'signUp',
        ...ageInput,
        acceptedLegal: 'true',
      })
      // Pass email to verify-email screen for OTP verification
      router.replace(routes.verifyEmail({ email: currentEmail, redirectTo }))
    } catch (error) {
      form$.error.set(getAuthErrorMessage(error))
    } finally {
      form$.isLoading.set(false)
    }
  }

  const submitDisabled = isLoading || ageStep === 'checking' || ageStep === 'blocked'

  return (
    <YStack flex={1} backgroundColor="$background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      <KeyboardAwareScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
      >
        <YStack justifyContent="center" paddingHorizontal={24} paddingVertical={40} gap={28}>
          {/* Header */}
          <YStack alignItems="center" gap={16}>
            <YStack
              width={80}
              height={80}
              borderRadius={40}
              backgroundColor={'$backgroundHover'}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={'$secondary'}
            >
              <UserPlus size={36} color={'$secondary'} />
            </YStack>
            <YStack alignItems="center" gap={8}>
              <Text fontSize={28} fontWeight="700">
                {completing ? 'Complete your registration' : 'Create account'}
              </Text>
              <Text fontSize={15} color={'$placeholderColor'}>
                Join Bondfires and start sharing
              </Text>
            </YStack>
          </YStack>

          {/* Form */}
          <YStack gap={16}>
            {/* First Name */}
            <YStack gap={8}>
              <Text variant="label" color={'$color'}>
                First Name
              </Text>
              <Input
                placeholder="First name"
                value={firstName}
                onChangeText={(text) => form$.firstName.set(text)}
                autoCapitalize="words"
                autoComplete="given-name"
                maxLength={100}
              />
            </YStack>

            {/* Last Name */}
            <YStack gap={8}>
              <Text variant="label" color={'$color'}>
                Last Name
              </Text>
              <Input
                placeholder="Last name"
                value={lastName}
                onChangeText={(text) => form$.lastName.set(text)}
                autoCapitalize="words"
                autoComplete="family-name"
                maxLength={100}
              />
            </YStack>

            {/* Email is supplied by the provider for social accounts. */}
            {!completing && (
              <YStack gap={8}>
                <Text variant="label" color={'$color'}>
                  Email
                </Text>
                <Input
                  placeholder="you@example.com"
                  value={email}
                  onChangeText={(text) => form$.email.set(text)}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                />
              </YStack>
            )}

            {/* Gender */}
            <YStack gap={8}>
              <Text variant="label" color={'$color'}>
                Gender
              </Text>
              <XStack gap={8}>
                {GENDER_OPTIONS.map((option) => {
                  const selected = gender === option.value
                  return (
                    <Button
                      key={option.value}
                      variant={selected ? 'primary' : 'outline'}
                      size="$md"
                      flex={1}
                      onPress={() => form$.gender.set(option.value)}
                    >
                      <Text color={selected ? '$color' : '$placeholderColor'} fontWeight="900">
                        {option.label}
                      </Text>
                    </Button>
                  )
                })}
              </XStack>
            </YStack>

            {/* Age: phone first, month/year only when the phone cannot answer. */}
            <YStack gap={8}>
              <Text variant="label" color={'$color'}>
                Age
              </Text>
              {ageStep === 'checking' && (
                <XStack gap={8} alignItems="center">
                  <Spinner size="small" color={'$placeholderColor'} />
                  <Text fontSize={12} color={'$placeholderColor'}>
                    Checking your device…
                  </Text>
                </XStack>
              )}
              {(ageStep === 'teen' || ageStep === 'adult') && (
                <XStack gap={8} alignItems="center">
                  <ShieldCheck size={18} color={'$success'} />
                  <Text fontSize={13} color={'$color'}>
                    Age confirmed from your device.
                  </Text>
                </XStack>
              )}
              {ageStep === 'blocked' && (
                <YStack
                  backgroundColor="$backgroundHover"
                  borderColor="$borderColor"
                  borderWidth={1}
                  borderRadius="$3"
                  padding="$3"
                  gap="$2"
                >
                  <Text fontSize={13} fontWeight="700" color="$color">
                    Bondfires isn’t available for your age range
                  </Text>
                  <Text fontSize={12} color="$placeholderColor" lineHeight={17}>
                    Your device reported an age range that Bondfires doesn’t support, so an account
                    can’t be created right now.
                  </Text>
                </YStack>
              )}
              {ageStep === 'ask' && (
                <YStack gap={8}>
                  <Text fontSize={12} color={'$placeholderColor'} marginBottom={4}>
                    Your birth month and year are private and are only used to keep 13–17 and adult
                    public communities separate. Private family Hearths require a separate
                    invitation and acceptance.
                  </Text>
                  <Text fontSize={12} color={'$color'}>
                    Birth month
                  </Text>
                  <XStack gap={6} flexWrap="wrap">
                    {MONTH_OPTIONS.map((label, index) => {
                      const month = index + 1
                      const selected = birthMonthIndex === month
                      return (
                        <Button
                          key={label}
                          variant={selected ? 'primary' : 'outline'}
                          size="$sm"
                          minWidth={56}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          onPress={() => {
                            form$.birthMonthIndex.set(month)
                            form$.error.set(null)
                          }}
                        >
                          <Text color={selected ? '$color' : '$placeholderColor'} fontWeight="700">
                            {label}
                          </Text>
                        </Button>
                      )
                    })}
                  </XStack>
                  <Text fontSize={12} color={'$color'}>
                    Birth year
                  </Text>
                  <Input
                    placeholder="YYYY"
                    value={birthYear}
                    onChangeText={(text) => {
                      form$.birthYear.set(text.replace(/[^0-9]/g, '').slice(0, 4))
                      form$.error.set(null)
                    }}
                    keyboardType="number-pad"
                    maxLength={4}
                    autoComplete="off"
                  />
                </YStack>
              )}
              {ageStep !== 'blocked' && (
                <YStack
                  backgroundColor="$backgroundHover"
                  borderColor="$borderColor"
                  borderWidth={1}
                  borderRadius="$3"
                  padding="$3"
                  gap="$2"
                >
                  <Text fontSize={13} fontWeight="700" color="$color">
                    Stay safe when sharing video
                  </Text>
                  <Text fontSize={12} color="$placeholderColor" lineHeight={17}>
                    Never share your address, school, exact location, passwords, or private contact
                    details. Tell a trusted adult and use Report if an interaction feels unsafe.
                  </Text>
                </YStack>
              )}
            </YStack>

            {!completing && (
              <>
                {/* Password */}
                <YStack gap={8}>
                  <Text variant="label" color={'$color'}>
                    Password
                  </Text>
                  <Input
                    placeholder="At least 8 characters"
                    value={password}
                    onChangeText={(text) => form$.password.set(text)}
                    secureTextEntry
                    autoCapitalize="none"
                    autoComplete="new-password"
                    autoCorrect={false}
                  />
                </YStack>

                {/* Confirm Password */}
                <YStack gap={8}>
                  <Text variant="label" color={'$color'}>
                    Confirm Password
                  </Text>
                  <Input
                    placeholder="Confirm your password"
                    value={confirmPassword}
                    onChangeText={(text) => form$.confirmPassword.set(text)}
                    secureTextEntry
                    autoCapitalize="none"
                    autoComplete="new-password"
                    autoCorrect={false}
                    error={confirmPassword.length > 0 && password !== confirmPassword}
                  />
                </YStack>
              </>
            )}
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: acceptedLegal }}
              accessibilityLabel="Accept Terms and Community Guidelines"
              onPress={() => form$.acceptedLegal.set(!form$.acceptedLegal.get())}
            >
              <XStack gap={10} alignItems="flex-start">
                {acceptedLegal ? (
                  <CheckSquare size={22} color={'$primary'} />
                ) : (
                  <Square size={22} color={'$placeholderColor'} />
                )}
                <Text flex={1} fontSize={13} color={'$placeholderColor'}>
                  I agree to the{' '}
                  <Text
                    color={'$primary'}
                    onPress={() => Linking.openURL('https://bondfires.org/terms')}
                  >
                    Terms
                  </Text>{' '}
                  and{' '}
                  <Text
                    color={'$primary'}
                    onPress={() => Linking.openURL('https://bondfires.org/community-guidelines')}
                  >
                    Community Guidelines
                  </Text>
                  . I have also reviewed the{' '}
                  <Text
                    color={'$primary'}
                    onPress={() => Linking.openURL('https://bondfires.org/privacy')}
                  >
                    Privacy Policy
                  </Text>
                  .
                </Text>
              </XStack>
            </Pressable>

            {error && (
              <Text color={'$error'} fontSize={14}>
                {error}
              </Text>
            )}
          </YStack>

          {/* Actions */}
          <YStack gap={12}>
            <Button variant="primary" size="$lg" onPress={handleSignup} disabled={submitDisabled}>
              {isLoading ? (
                <Spinner color={'$color'} />
              ) : (
                <>
                  <Flame size={20} color={'$color'} />
                  <Text color={'$color'}>
                    {completing ? 'Finish Registration' : 'Create Account'}
                  </Text>
                </>
              )}
            </Button>

            <Button
              variant="ghost"
              size="$md"
              disabled={isLoading}
              onPress={async () => {
                if (completing) {
                  clearRegistrationDestination()
                  await signOut()
                }
                router.replace(routes.login(destination))
              }}
            >
              <Text>
                {completing ? 'Use a different account' : 'Already have an account? Sign in'}
              </Text>
            </Button>
            {completing && (
              <Button
                variant="ghost"
                disabled={isLoading}
                onPress={() => {
                  Alert.alert(
                    'Delete unfinished account?',
                    'Your account will be permanently deleted.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete account',
                        style: 'destructive',
                        onPress: async () => {
                          form$.isLoading.set(true)
                          try {
                            await deleteAccount()
                            clearRegistrationDestination()
                            await signOut()
                            router.replace(routes.login())
                          } catch (error) {
                            form$.error.set(getAuthErrorMessage(error))
                          } finally {
                            form$.isLoading.set(false)
                          }
                        },
                      },
                    ],
                  )
                }}
              >
                <Text color="$error">Delete unfinished account</Text>
              </Button>
            )}
          </YStack>
        </YStack>
      </KeyboardAwareScrollView>
    </YStack>
  )
}
