/**
 * Sending mail, without taking on a mail dependency.
 *
 * Two transports:
 *   - console (default): prints the message, including the reset link. Enough
 *     to develop and test against, and it never silently "succeeds" the way a
 *     misconfigured SMTP client does.
 *   - resend: if RESEND_API_KEY is set, posts to Resend's HTTP API with fetch.
 *     No SDK, no build step.
 *
 * Anything else — SES, Postmark, SMTP — is one more branch in `send` below.
 */

const FROM = process.env.MAIL_FROM ?? 'Soccerboard <onboarding@resend.dev>'

async function sendViaResend({ to, subject, text }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: [to], subject, text }),
  })
  if (!response.ok) {
    // Surfaced to the caller, which logs it. The HTTP response to the user is
    // deliberately unchanged, so a mail outage cannot be used to probe for
    // which addresses exist.
    throw new Error(`Resend refused the message (${response.status})`)
  }
}

function sendViaConsole({ to, subject, text }) {
  console.log(
    ['', '─── email (console transport) ───', `to:      ${to}`, `subject: ${subject}`, '', text, '─────────────────────────────────', ''].join('\n'),
  )
}

export const transportName = process.env.RESEND_API_KEY ? 'resend' : 'console'

export async function send(message) {
  if (transportName === 'resend') return sendViaResend(message)
  return sendViaConsole(message)
}

export function passwordResetEmail({ to, link, minutes }) {
  return {
    to,
    subject: 'Reset your Soccerboard password',
    text: [
      'Someone asked to reset the password for this Soccerboard account.',
      '',
      'Open this link to choose a new one:',
      link,
      '',
      `The link works once and expires in ${minutes} minutes.`,
      '',
      "If this wasn't you, ignore this message — your password has not changed.",
    ].join('\n'),
  }
}
