import { bondfireColors } from '@bondfires/config'
import { Button, Input, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { useObservable, useValue } from '@legendapp/state/react'
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker'
import { Flame, UserPlus } from '@tamagui/lucide-icons'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar } from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'

type Gender = 'male' | 'female' | 'other'

const GENDER_OPTIONS: Array<{ value: Gender; label: string }> = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
]

/**
 * Format a Date to YYYY-MM-DD string.
 */
function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Minimum age to join Bondfires */
const MIN_AGE = 13

/** Earliest allowed birth date (user must be at least MIN_AGE years old) */
function getMinBirthDate(): Date {
  const today = new Date()
  const minYear = today.getFullYear() - MIN_AGE
  const minDate = new Date(minYear, today.getMonth(), today.getDate())
  // If today's month/day is before the birth month/day, push back one day
  if (minDate > today) {
    return new Date(minYear - 1, today.getMonth(), today.getDate())
  }
  return minDate
}

export default function SignupScreen() {
  const router = useRouter()
  const { signIn } = useAuthActions()

  const form$ = useObservable({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
    gender: null as Gender | null,
    birthDate: '',
    isLoading: false,
    error: null as string | null,
  })

  const firstName = useValue(form$.firstName)
  const lastName = useValue(form$.lastName)
  const email = useValue(form$.email)
  const password = useValue(form$.password)
  const confirmPassword = useValue(form$.confirmPassword)
  const gender = useValue(form$.gender)
  const birthDate = useValue(form$.birthDate)
  const isLoading = useValue(form$.isLoading)
  const error = useValue(form$.error)

  // Date picker state
  const [showDatePicker, setShowDatePicker] = useState(false)

  const handleSignup = async () => {
    const currentFirstName = form$.firstName.get().trim()
    const currentLastName = form$.lastName.get().trim()
    const currentEmail = form$.email.get().trim()
    const currentPassword = form$.password.get()
    const currentConfirmPassword = form$.confirmPassword.get()
    const currentGender = form$.gender.get()
    const currentBirthDate = form$.birthDate.get().trim()

    if (
      !currentFirstName ||
      !currentLastName ||
      !currentEmail ||
      !currentPassword ||
      !currentGender ||
      !currentBirthDate
    ) {
      form$.error.set('Please fill in all fields')
      return
    }

    // Validate birth date format (YYYY-MM-DD)
    const birthMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(currentBirthDate)
    if (!birthMatch) {
      form$.error.set('Birth date must be in YYYY-MM-DD format')
      return
    }

    const birthYear = Number(birthMatch[1])
    const birthMonth = Number(birthMatch[2])
    const birthDay = Number(birthMatch[3])
    const birth = new Date(birthYear, birthMonth - 1, birthDay)

    // Validate the date is real
    if (
      birth.getFullYear() !== birthYear ||
      birth.getMonth() !== birthMonth - 1 ||
      birth.getDate() !== birthDay
    ) {
      form$.error.set('Birth date is not a valid calendar date')
      return
    }

    // Age check
    const today = new Date()
    let age = today.getFullYear() - birthYear
    const monthDelta = today.getMonth() - (birthMonth - 1)
    if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birthDay)) {
      age -= 1
    }
    if (age < MIN_AGE) {
      form$.error.set(`You must be at least ${MIN_AGE} years old to join`)
      return
    }

    // Future date check
    if (birth > today) {
      form$.error.set('Birth date cannot be in the future')
      return
    }

    if (currentPassword !== currentConfirmPassword) {
      form$.error.set('Passwords do not match')
      return
    }

    if (currentPassword.length < 8) {
      form$.error.set('Password must be at least 8 characters')
      return
    }

    form$.isLoading.set(true)
    form$.error.set(null)

    try {
      await signIn('password', {
        email: currentEmail,
        password: currentPassword,
        firstName: currentFirstName,
        lastName: currentLastName,
        gender: currentGender,
        flow: 'signUp',
        birthDate: currentBirthDate,
      })
      // Pass email to verify-email screen for OTP verification
      router.replace({ pathname: '/(auth)/verify-email', params: { email: currentEmail } })
    } catch {
      form$.error.set('Could not create account. Please try again.')
    } finally {
      form$.isLoading.set(false)
    }
  }

  const handleDateChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowDatePicker(Platform.OS === 'ios')
    if (selectedDate) {
      form$.birthDate.set(formatDate(selectedDate))
      form$.error.set(null)
    }
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
        >
          <YStack justifyContent="center" paddingHorizontal={24} paddingVertical={40} gap={28}>
            {/* Header */}
            <YStack alignItems="center" gap={16}>
              <YStack
                width={80}
                height={80}
                borderRadius={40}
                backgroundColor={bondfireColors.gunmetal}
                alignItems="center"
                justifyContent="center"
                borderWidth={2}
                borderColor={bondfireColors.moltenGold}
              >
                <UserPlus size={36} color={bondfireColors.moltenGold} />
              </YStack>
              <YStack alignItems="center" gap={8}>
                <Text fontSize={28} fontWeight="700">
                  Create account
                </Text>
                <Text fontSize={15} color={bondfireColors.ash}>
                  Join Bondfires and start sharing
                </Text>
              </YStack>
            </YStack>

            {/* Form */}
            <YStack gap={16}>
              {/* First Name */}
              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
                  First Name
                </Text>
                <Input
                  placeholder="First name"
                  value={firstName}
                  onChangeText={(text) => form$.firstName.set(text)}
                  autoCapitalize="words"
                  autoComplete="given-name"
                />
              </YStack>

              {/* Last Name */}
              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
                  Last Name
                </Text>
                <Input
                  placeholder="Last name"
                  value={lastName}
                  onChangeText={(text) => form$.lastName.set(text)}
                  autoCapitalize="words"
                  autoComplete="family-name"
                />
              </YStack>

              {/* Email */}
              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
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

              {/* Gender */}
              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
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
                        <Text
                          color={selected ? bondfireColors.whiteSmoke : bondfireColors.ash}
                          fontWeight="900"
                        >
                          {option.label}
                        </Text>
                      </Button>
                    )
                  })}
                </XStack>
              </YStack>

              {/* Birth Date with Calendar Picker */}
              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
                  Birth Date
                </Text>
                <Text fontSize={12} color={bondfireColors.ash} marginBottom={4}>
                  Required. You must be at least 13. Private; not shown publicly.
                </Text>
                <Pressable onPress={() => setShowDatePicker(true)}>
                  <YStack pointerEvents="none">
                    <Input
                      placeholder="YYYY-MM-DD"
                      value={birthDate}
                      editable={false}
                      autoCapitalize="none"
                    />
                  </YStack>
                </Pressable>
                {showDatePicker && (
                  <DateTimePicker
                    value={birthDate ? new Date(`${birthDate}T00:00:00`) : getMinBirthDate()}
                    mode="date"
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    maximumDate={getMinBirthDate()}
                    onChange={handleDateChange}
                  />
                )}
              </YStack>

              {/* Password */}
              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
                  Password
                </Text>
                <Input
                  placeholder="At least 8 characters"
                  value={password}
                  onChangeText={(text) => form$.password.set(text)}
                  secureTextEntry
                  autoComplete="new-password"
                />
              </YStack>

              {/* Confirm Password */}
              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
                  Confirm Password
                </Text>
                <Input
                  placeholder="Confirm your password"
                  value={confirmPassword}
                  onChangeText={(text) => form$.confirmPassword.set(text)}
                  secureTextEntry
                  autoComplete="new-password"
                  error={confirmPassword.length > 0 && password !== confirmPassword}
                />
              </YStack>

              {error && (
                <Text color={bondfireColors.error} fontSize={14}>
                  {error}
                </Text>
              )}
            </YStack>

            {/* Actions */}
            <YStack gap={12}>
              <Button variant="primary" size="$lg" onPress={handleSignup} disabled={isLoading}>
                {isLoading ? (
                  <Spinner color={bondfireColors.whiteSmoke} />
                ) : (
                  <>
                    <Flame size={20} color={bondfireColors.whiteSmoke} />
                    <Text color={bondfireColors.whiteSmoke}>Create Account</Text>
                  </>
                )}
              </Button>

              <Button variant="ghost" size="$md" onPress={() => router.push('/(auth)/login')}>
                <Text>Already have an account? Sign in</Text>
              </Button>
            </YStack>
          </YStack>
        </ScrollView>
      </KeyboardAvoidingView>
    </YStack>
  )
}
