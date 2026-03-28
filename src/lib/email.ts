import { Resend } from 'resend'

let _resend: Resend | null = null
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

export async function sendFeedbackNotification(feedback: {
  type: string
  message: string
  page: string
  userName: string | null
}) {
  const typeLabel = feedback.type.charAt(0).toUpperCase() + feedback.type.slice(1)
  await getResend().emails.send({
    from: 'Cinemagraphs <noreply@cinemagraphs.ca>',
    to: 'cinemagraphs.corp@gmail.com',
    subject: `[${typeLabel}] New feedback from ${feedback.userName || 'Anonymous'}`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; padding: 40px 20px; background: #0D0D1A; color: #F0E6D3;">
        <h1 style="color: #C8A951; font-size: 24px; margin-bottom: 4px;">New Feedback</h1>
        <p style="color: rgba(255,255,255,0.5); font-size: 13px; margin-bottom: 24px;">from ${feedback.userName || 'Anonymous'}</p>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <tr><td style="color: rgba(255,255,255,0.5); padding: 6px 0; font-size: 13px;">Type</td><td style="color: #F0E6D3; padding: 6px 0; font-size: 13px;">${typeLabel}</td></tr>
          <tr><td style="color: rgba(255,255,255,0.5); padding: 6px 0; font-size: 13px;">Page</td><td style="color: #F0E6D3; padding: 6px 0; font-size: 13px;">${feedback.page}</td></tr>
        </table>
        <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(200,169,81,0.3); border-radius: 12px; padding: 16px;">
          <p style="color: #F0E6D3; font-size: 14px; line-height: 1.6; margin: 0; white-space: pre-wrap;">${feedback.message}</p>
        </div>
      </div>
    `,
  })
}

export async function sendPasswordResetEmail(email: string, resetUrl: string) {
  await getResend().emails.send({
    from: 'Cinemagraphs <noreply@cinemagraphs.ca>',
    to: email,
    subject: 'Reset your Cinemagraphs password',
    html: `
      <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0D0D1A; color: #F0E6D3;">
        <h1 style="color: #C8A951; font-size: 28px; margin-bottom: 8px;">Cinemagraphs</h1>
        <p style="color: rgba(255,255,255,0.6); font-size: 14px; margin-bottom: 32px;">Password reset request</p>
        <p style="color: #F0E6D3; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">Click the button below to reset your password. This link expires in 1 hour.</p>
        <div style="text-align: center; margin-bottom: 24px;">
          <a href="${resetUrl}" style="display: inline-block; background: #C8A951; color: #0D0D1A; font-weight: bold; font-size: 14px; padding: 12px 32px; border-radius: 8px; text-decoration: none;">Reset Password</a>
        </div>
        <p style="color: rgba(255,255,255,0.5); font-size: 13px;">If you didn't request this, you can safely ignore this email. Your password will not change.</p>
      </div>
    `,
  })
}

export async function sendVerificationOTP(email: string, code: string) {
  await getResend().emails.send({
    from: 'Cinemagraphs <noreply@cinemagraphs.ca>',
    to: email,
    subject: 'Your Cinemagraphs verification code',
    html: `
      <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0D0D1A; color: #F0E6D3;">
        <h1 style="color: #C8A951; font-size: 28px; margin-bottom: 8px;">Cinemagraphs</h1>
        <p style="color: rgba(255,255,255,0.6); font-size: 14px; margin-bottom: 32px;">Your verification code</p>
        <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(200,169,81,0.3); border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 36px; letter-spacing: 8px; color: #C8A951; font-weight: bold;">${code}</span>
        </div>
        <p style="color: rgba(255,255,255,0.5); font-size: 13px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  })
}
