import { useState } from 'react'
import { useRouter } from 'expo-router'
import { YStack, H1, Paragraph, Spinner } from 'tamagui'
import { Button, Input, Container, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'

export default function SignupScreen() {
  const router = useRouter()
  const { signIn } = useAuthActions()
  
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const handleSignup = async () => {
    if (!name || !email || !password) {
      setError('Please fill in all fields')
      return
    }
    
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    
    setIsLoading(true)
    setError(null)
    
    try {
      await signIn('password', { email, password, name, flow: 'signUp' })
      router.replace('/(auth)/verify-email')
    } catch (err) {
      setError('Could not create account. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }
  
  return (
    <Container padded safe>
      <YStack flex={1} justifyContent="center" gap="$6">
        <YStack gap="$2">
          <H1>Create account</H1>
          <Paragraph color="$gray11">
            Join Bondfires and start sharing
          </Paragraph>
        </YStack>
        
        <YStack gap="$4">
          <YStack gap="$2">
            <Text variant="label">Name</Text>
            <Input
              placeholder="Your name"
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              autoComplete="name"
            />
          </YStack>
          
          <YStack gap="$2">
            <Text variant="label">Email</Text>
            <Input
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
            />
          </YStack>
          
          <YStack gap="$2">
            <Text variant="label">Password</Text>
            <Input
              placeholder="At least 8 characters"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="new-password"
            />
          </YStack>
          
          <YStack gap="$2">
            <Text variant="label">Confirm Password</Text>
            <Input
              placeholder="Confirm your password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              autoComplete="new-password"
              error={confirmPassword.length > 0 && password !== confirmPassword}
            />
          </YStack>
          
          {error && (
            <Text color="$red10" fontSize="$2">
              {error}
            </Text>
          )}
        </YStack>
        
        <YStack gap="$3">
          <Button
            variant="primary"
            size="lg"
            onPress={handleSignup}
            disabled={isLoading}
          >
            {isLoading ? <Spinner color="$white" /> : 'Create Account'}
          </Button>
          
          <Button
            variant="ghost"
            size="md"
            onPress={() => router.push('/(auth)/login')}
          >
            Already have an account? Sign in
          </Button>
        </YStack>
      </YStack>
    </Container>
  )
}

