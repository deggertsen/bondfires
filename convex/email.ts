import { v } from 'convex/values'
import { internalAction } from './_generated/server'

// Email sending configuration
// Set RESEND_API_KEY in your Convex dashboard under Settings > Environment Variables
// Sign up at https://resend.com for an API key

interface EmailOptions {
  to: string
  subject: string
  html: string
  text?: string
}

// Send an email using Resend API
async function sendEmail(
  apiKey: string,
  options: EmailOptions,
): Promise<{ success: boolean; error?: string; id?: string }> {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Bondfires <noreply@bondfires.org>',
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      return { success: false, error: `Email send failed: ${response.status} - ${error}` }
    }

    const result = await response.json()
    return { success: true, id: result.id }
  } catch (error) {
    return { success: false, error: `Email send error: ${error}` }
  }
}

// Send verification email
export const sendVerificationEmail = internalAction({
  args: {
    email: v.string(),
    code: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<{ success: boolean; error?: string }> => {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      // In development without RESEND_API_KEY, skip email sending
      // The verification will still work, just no email is sent
      return { success: true }
    }

    const greeting = args.name ? `Hi ${args.name}` : 'Hi there'

    return await sendEmail(apiKey, {
      to: args.email,
      subject: '🔥 Verify your Bondfires account',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #FF6B35; margin-bottom: 24px;">🔥 Bondfires</h1>
          <p style="font-size: 16px; color: #333;">${greeting}!</p>
          <p style="font-size: 16px; color: #333;">Welcome to Bondfires! Please verify your email address by entering this code:</p>
          <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 24px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #FF6B35;">${args.code}</span>
          </div>
          <p style="font-size: 14px; color: #666;">This code expires in 15 minutes.</p>
          <p style="font-size: 14px; color: #666;">If you didn't create a Bondfires account, you can safely ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
          <p style="font-size: 12px; color: #999;">© ${new Date().getFullYear()} Bondfires. All rights reserved.</p>
        </div>
      `,
      text: `${greeting}! Your Bondfires verification code is: ${args.code}. This code expires in 15 minutes.`,
    })
  },
})

// Send password reset email
export const sendPasswordResetEmail = internalAction({
  args: {
    email: v.string(),
    code: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<{ success: boolean; error?: string }> => {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      // In development without RESEND_API_KEY, skip email sending
      return { success: true }
    }

    const greeting = args.name ? `Hi ${args.name}` : 'Hi there'

    return await sendEmail(apiKey, {
      to: args.email,
      subject: '🔑 Reset your Bondfires password',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #FF6B35; margin-bottom: 24px;">🔥 Bondfires</h1>
          <p style="font-size: 16px; color: #333;">${greeting}!</p>
          <p style="font-size: 16px; color: #333;">We received a request to reset your password. Use this code to set a new password:</p>
          <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 24px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #FF6B35;">${args.code}</span>
          </div>
          <p style="font-size: 14px; color: #666;">This code expires in 15 minutes.</p>
          <p style="font-size: 14px; color: #666;">If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
          <p style="font-size: 12px; color: #999;">© ${new Date().getFullYear()} Bondfires. All rights reserved.</p>
        </div>
      `,
      text: `${greeting}! Your Bondfires password reset code is: ${args.code}. This code expires in 15 minutes. If you didn't request this, ignore this email.`,
    })
  },
})

// Send welcome email after verification
export const sendWelcomeEmail = internalAction({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<{ success: boolean; error?: string }> => {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      // In development without RESEND_API_KEY, skip email sending
      return { success: true }
    }

    const greeting = args.name ? `Hi ${args.name}` : 'Hi there'

    return await sendEmail(apiKey, {
      to: args.email,
      subject: '🎉 Welcome to Bondfires!',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #FF6B35; margin-bottom: 24px;">🔥 Bondfires</h1>
          <p style="font-size: 16px; color: #333;">${greeting}!</p>
          <p style="font-size: 16px; color: #333;">Your email has been verified and your Bondfires account is ready to go!</p>
          <p style="font-size: 16px; color: #333;">Here's what you can do next:</p>
          <ul style="font-size: 16px; color: #333; line-height: 1.8;">
            <li>🎬 <strong>Spark a Bondfire</strong> - Share a video to start a conversation</li>
            <li>💬 <strong>Respond to Bondfires</strong> - Add your video to existing conversations</li>
            <li>👤 <strong>Complete your profile</strong> - Let others know who you are</li>
          </ul>
          <p style="font-size: 16px; color: #333;">We're excited to have you! 🔥</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
          <p style="font-size: 12px; color: #999;">© ${new Date().getFullYear()} Bondfires. All rights reserved.</p>
        </div>
      `,
      text: `${greeting}! Your Bondfires account is verified and ready. Spark a Bondfire to start a conversation!`,
    })
  },
})
