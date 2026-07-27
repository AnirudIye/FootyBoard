import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuthStore } from '../../store/authStore'
import { toUserMessage } from '../../lib/errors'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'

type Mode = 'signup' | 'login'

export default function AuthPage({ mode }: { mode: Mode }) {
  const navigate = useNavigate()
  const signUp = useAuthStore((s) => s.signUp)
  const logIn = useAuthStore((s) => s.logIn)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isSignup = mode === 'signup'

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (isSignup) await signUp(email, password, accepted)
      else await logIn(email, password)
      navigate('/board')
    } catch (err) {
      setError(toUserMessage(err, 'That did not work. Check the details and try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title={isSignup ? 'Create an account' : 'Welcome back'}>
      {/* Not the shell's `subtitle`, which is the quieter 13px grey the join
          and password pages want. This one is doing more explaining. */}
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        {isSignup
          ? 'An account is what makes a board stick around. Without one everything still works, it just is not kept.'
          : 'Sign in to pick up where you left off.'}
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
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className={field}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
            Password
          </span>
          <input
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSignup ? 'At least 8 characters' : ''}
            className={field}
          />
        </label>

        {isSignup && (
          <label className="flex cursor-pointer items-start gap-2.5 pt-1">
            <input
              type="checkbox"
              required
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[rgb(var(--accent))]"
            />
            <span className="text-[13px] leading-relaxed text-ink-2">
              I agree to the{' '}
              <Link to="/terms" target="_blank" className="text-accent underline underline-offset-2">
                Terms of Service
              </Link>{' '}
              and the{' '}
              <Link to="/privacy" target="_blank" className="text-accent underline underline-offset-2">
                Privacy Policy
              </Link>
              .
            </span>
          </label>
        )}

        {error && <FormError>{error}</FormError>}

        <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
          {busy ? 'Working…' : isSignup ? 'Create account' : 'Sign in'}
        </motion.button>
      </form>

      {!isSignup && (
        <p className="mt-4 text-[13px]">
          <Link to="/forgot" className="text-accent underline underline-offset-2">
            Forgotten your password?
          </Link>
        </p>
      )}

      <p className="mt-5 text-[13px] text-ink-2">
        {isSignup ? 'Already have an account? ' : 'No account yet? '}
        <Link
          to={isSignup ? '/login' : '/signup'}
          className="text-accent underline underline-offset-2"
        >
          {isSignup ? 'Sign in' : 'Create one'}
        </Link>
      </p>

      <p className="mt-8 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
        Your password is hashed before it is stored, and never kept in readable form. If you forget
        it, a reset link can be sent to this address.
      </p>

      <p className="mt-4 text-[12px] text-ink-3">
        <Link to="/board" className="underline underline-offset-2 transition-colors hover:text-accent">
          Continue as a guest
        </Link>{' '}
        for a full board that is never saved.
      </p>
    </AuthShell>
  )
}
