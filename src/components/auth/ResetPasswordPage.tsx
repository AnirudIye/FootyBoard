import { useState } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { api } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { AuthShell, field } from './AuthShell'

export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') ?? ''

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
      setError(toUserMessage(err, 'That reset link did not work. Request a new one.'))
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <AuthShell title="That link is incomplete">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          The reset link is missing its token. It may have been cut short by your email client.
        </p>
        <p className="mt-6 text-[13px]">
          <Link to="/forgot" className="text-accent underline underline-offset-2">
            Request a new link
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
          className="mt-6 w-full rounded bg-accent px-4 py-2.5 text-[14px] font-medium text-paper
            transition-colors duration-150 hover:bg-accent-hover
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-accent"
        >
          Sign in
        </motion.button>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Choose a new password">
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        Pick something at least 8 characters long. This link works once.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4">
        <label className="block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
            New password
          </span>
          <input
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            className={field}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
            Confirm
          </span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={field}
          />
        </label>

        {error && (
          <p
            role="alert"
            className="rounded border border-accent/40 bg-[var(--accent-wash)] px-3 py-2 text-[13px] leading-relaxed text-ink"
          >
            {error}
          </p>
        )}

        <motion.button
          type="submit"
          whileTap={{ scale: 0.98 }}
          disabled={busy}
          className="w-full rounded bg-accent px-4 py-2.5 text-[14px] font-medium text-paper
            transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-accent"
        >
          {busy ? 'Saving…' : 'Set the new password'}
        </motion.button>
      </form>
    </AuthShell>
  )
}
