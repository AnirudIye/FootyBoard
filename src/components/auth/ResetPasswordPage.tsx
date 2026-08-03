import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { api } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { AuthShell, submitBtn, FormError } from './AuthShell'
import { PasswordField } from './PasswordField'

/**
 * Step three of recovery: the new password.
 *
 * The token arrives in history state, put there by `ForgotPasswordPage` after
 * the security question was answered correctly. It used to arrive as `?token=`
 * because it came out of an email, and it no longer does: a credential in a
 * query string is written into the address bar, the browser history and the
 * `Referer` of anything the page goes on to load. History state survives a
 * reload of this entry, which is the only thing the query string was buying.
 */
export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const { state } = useLocation()
  const token = typeof (state as { token?: unknown } | null)?.token === 'string'
    ? (state as { token: string }).token
    : ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Checked here purely for a quicker answer; the server enforces the rest.
    if (password !== confirm) return setError('Those two passwords do not match.')
    setError(null)
    setBusy(true)
    try {
      await api.resetPassword(token, password)
      setDone(true)
    } catch (err) {
      setError(toUserMessage(err, 'That reset did not go through. Answer your question again.'))
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <AuthShell title="Start from the beginning">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          This page is the last step of a password reset, and there is nothing here to finish.
          Answer your security question first.
        </p>
        <p className="mt-6 text-[13px]">
          <Link to="/forgot" className="text-accent underline underline-offset-2">
            Reset your password
          </Link>
        </p>
      </AuthShell>
    )
  }

  if (done) {
    return (
      <AuthShell title="Password changed">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          You can sign in with the new one now. Anywhere that was already signed in to this account
          has been signed out.
        </p>
        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={() => navigate('/login')}
          className={`mt-6 ${submitBtn}`}
        >
          Sign in
        </motion.button>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Choose a new password">
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        Pick something at least 8 characters long. This works once, and signs out anywhere else
        that is already signed in to the account.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4">
        <PasswordField
          label="New password"
          autoComplete="new-password"
          required
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
        />

        <PasswordField
          label="Confirm"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />

        {error && <FormError>{error}</FormError>}

        <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
          {busy ? 'Saving…' : 'Set the new password'}
        </motion.button>
      </form>
    </AuthShell>
  )
}
