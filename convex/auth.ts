import { Password } from '@convex-dev/auth/providers/Password'
import Resend from '@auth/core/providers/resend'
import { convexAuth } from '@convex-dev/auth/server'

// Generate a 6-digit numeric OTP using crypto for security
function generateOTP(): string {
  // Use crypto.getRandomValues for secure random numbers
  const array = new Uint32Array(1)
  crypto.getRandomValues(array)
  // Get a 6-digit number (000000 to 999999)
  const code = (array[0] % 1000000).toString().padStart(6, '0')
  return code
}

// Custom Resend email provider for OTP verification
const ResendOTP = Resend({
  id: 'resend-otp',
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.EMAIL_FROM ?? 'Bondfires <noreply@bondfires.app>',
  maxAge: 15 * 60, // 15 minutes
  // Generate 6-digit numeric OTP instead of long secure token
  generateVerificationToken: generateOTP,
  // Custom email template with OTP code
  async sendVerificationRequest({ identifier: email, token }) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? 'Bondfires <noreply@bondfires.app>',
        to: email,
        subject: '🔥 Verify your Bondfires account',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #FF6B35; margin-bottom: 24px;">🔥 Bondfires</h1>
            <p style="font-size: 16px; color: #333;">Welcome to Bondfires!</p>
            <p style="font-size: 16px; color: #333;">Please verify your email address by entering this code:</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 24px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #FF6B35;">${token}</span>
            </div>
            <p style="font-size: 14px; color: #666;">This code expires in 15 minutes.</p>
            <p style="font-size: 14px; color: #666;">If you didn't create a Bondfires account, you can safely ignore this email.</p>
          </div>
        `,
        text: `Your Bondfires verification code is: ${token}. This code expires in 15 minutes.`,
      }),
    })

    if (!res.ok) {
      const error = await res.text()
      throw new Error(`Failed to send verification email: ${error}`)
    }
  },
})

// Password provider with email verification and profile support
const PasswordWithVerification = Password({
  // Profile fields to include when creating a user
  profile(params) {
    return {
      name: (params.name as string) ?? null,
      email: params.email as string,
    }
  },
  // Require email verification before allowing sign in
  verify: ResendOTP,
})

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [PasswordWithVerification],
})
