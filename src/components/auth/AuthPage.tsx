import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuthStore } from '../../store/authStore'
import { toUserMessage } from '../../lib/errors'

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

  const field =
    'w-full rounded border border-rule bg-sunken px-3 py-2 text-[14px] text-ink ' +
    'placeholder:text-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'

  return (
    <div className="grid min-h-screen place-items-center bg-paper px-5 py-12 text-ink">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[400px]"
      >
        <Link to="/" className="mb-8 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span className="font-display text-[18px] font-semibold tracking-[-0.02em]">
            FootyBoard
          </span>
        </Link>

        <h1 className="font-display text-[28px] font-medium leading-tight tracking-[-0.025em]">
          {isSignup ? 'Create an account' : 'Welcome back'}
        </h1>
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

          {error && (
            <p
              role="alert"
              className="rounded border border-accent/40 bg-[var(--accent-wash)] px-3 py-2 text-[13px] leading-relaxed text-ink"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-accent px-4 py-2.5 text-[14px] font-medium text-paper
              transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-accent"
          >
            {busy ? 'Working…' : isSignup ? 'Create account' : 'Sign in'}
          </button>
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
          Your password is hashed before it is stored, and never kept in readable form. There is no
          password reset yet, so pick something you will remember.
        </p>

        <p className="mt-4 text-[12px] text-ink-3">
          <Link to="/board" className="underline underline-offset-2 transition-colors hover:text-accent">
            Continue as a guest
          </Link>{' '}
          for a full board that is never saved.
        </p>
      </motion.div>
    </div>
  )
}
