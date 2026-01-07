import { useState } from 'react'
import { useRouter } from 'expo-router'
import { YStack, H1, Paragraph, Spinner } from 'tamagui'
import { Button, Input, Container, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'

export default function LoginScreen() {
  const router = useRouter()
  const { signIn } = useAuthActions()
  
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const handleLogin = async () => {
    if (!email || !password) {
      setError('Please enter your email and password')
      return
    }
    
    setIsLoading(true)
    setError(null)
    
    try {
      await signIn('password', { email, password, flow: 'signIn' })
      router.replace('/(main)/feed')
    } catch (err) {
      setError('Invalid email or password')
    } finally {
      setIsLoading(false)
    }
  }
  
  return (
    <Container padded safe>
      <YStack flex={1} justifyContent="center" gap="$6">
        <YStack gap="$2">
          <H1>Welcome back</H1>
          <Paragraph color="$gray11">
            Sign in to continue to Bondfires
          </Paragraph>
        </YStack>
        
        <YStack gap="$4">
          <YStack gap="$2">
            <Text variant="label">Email</Text>
            <Input
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              error={!!error}
            />
          </YStack>
          
          <YStack gap="$2">
            <Text variant="label">Password</Text>
            <Input
              placeholder="Your password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              error={!!error}
            />
          </YStack>
          
          {error && (
            <Text color="$red10" fontSize="$2">
              {error}
            </Text>
          )}
          
          <Button
            variant="ghost"
            size="sm"
            alignSelf="flex-end"
            onPress={() => router.push('/(auth)/forgot-password')}
          >
            Forgot password?
          </Button>
        </YStack>
        
        <YStack gap="$3">
          <Button
            variant="primary"
            size="lg"
            onPress={handleLogin}
            disabled={isLoading}
          >
            {isLoading ? <Spinner color="$white" /> : 'Sign In'}
          </Button>
          
          <Button
            variant="outline"
            size="md"
            onPress={() => router.push('/(auth)/signup')}
          >
            Create an account
          </Button>
        </YStack>
      </YStack>
    </Container>
  )
}

