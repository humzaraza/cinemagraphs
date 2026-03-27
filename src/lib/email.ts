import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function sendVerificationOTP(email: string, code: string) {
  await resend.emails.send({
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
