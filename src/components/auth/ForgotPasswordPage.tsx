import { useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { api } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.requestPasswordReset(email)
      setSent(true)
    } catch (err) {
      setError(toUserMessage(err, 'That did not work. Try again in a moment.'))
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <AuthShell title="Check your email">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          If <span className="text-ink">{email}</span> has an account, a reset link is on its way.
          It works once and expires in 30 minutes.
        </p>
        <p className="mt-4 text-[13px] leading-relaxed text-ink-3">
          Nothing arrived? Check the spam folder, or{' '}
          <button
            onClick={() => setSent(false)}
            className="text-accent underline underline-offset-2"
          >
            try a different address
          </button>
          .
        </p>
        <p className="mt-6 text-[13px]">
          <Link to="/login" className="text-accent underline underline-offset-2">
            Back to sign in
          </Link>
        </p>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Reset your password">
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        Give us the address on the account and we'll send a link to set a new password.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4">
        <label className="block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
            Email
          </span>
          <input
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className={field}
          />
        </label>

        {error && <FormError>{error}</FormError>}

        <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
          {busy ? 'Sending…' : 'Send the link'}
        </motion.button>
      </form>

      <p className="mt-5 text-[13px] text-ink-2">
        Remembered it?{' '}
        <Link to="/login" className="text-accent underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </AuthShell>
  )
}
