import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { api } from '../../lib/api'
import type { SecurityQuestion } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'

/**
 * Recovery, steps one and two. Step three is `ResetPasswordPage`.
 *
 * Nothing is emailed any more. The security question set at signup is what
 * proves the account is yours, so this page asks for the address, shows the
 * question that guards it, and takes the answer.
 *
 * **Every address gets a question back**, including addresses with no account.
 * That is deliberate and is the reason this can be a single screen: if an
 * unknown address were told "no such account", this page would be a way to find
 * out who is registered. An answer to a question nobody set simply fails, in
 * exactly the words a wrong answer fails in.
 */
export default function ForgotPasswordPage() {
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [question, setQuestion] = useState<SecurityQuestion | null>(null)
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const askForQuestion = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const { question: next } = await api.startPasswordRecovery(email)
      setQuestion(next)
    } catch (err) {
      setError(toUserMessage(err, 'That did not work. Try again in a moment.'))
    } finally {
      setBusy(false)
    }
  }

  const submitAnswer = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const { token } = await api.verifySecurityAnswer(email, answer)
      // The token travels in history state rather than in the URL. It is a
      // credential, and a query string is written into the address bar, the
      // browser history, and any Referer the next page sends.
      navigate('/reset', { replace: true, state: { token } })
    } catch (err) {
      setError(toUserMessage(err, 'That answer did not work. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  if (question) {
    return (
      <AuthShell title="Answer your security question">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          This is the question set on <span className="text-ink">{email}</span>. Get it right and you
          can choose a new password.
        </p>

        <form onSubmit={submitAnswer} className="mt-7 space-y-4">
          <div>
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
              Question
            </span>
            <p className="rounded border border-rule bg-sunken px-3 py-2 text-[14px] leading-relaxed text-ink">
              {question.label}
            </p>
          </div>

          <label className="block">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
              Answer
            </span>
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
              autoFocus
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              className={field}
            />
            <span className="mt-1.5 block text-[12px] leading-relaxed text-ink-3">
              Capitals and extra spaces are ignored.
            </span>
          </label>

          {error && <FormError>{error}</FormError>}

          <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
            {busy ? 'Checking…' : 'Continue'}
          </motion.button>
        </form>

        <p className="mt-5 text-[13px] text-ink-2">
          Wrong address?{' '}
          <button
            onClick={() => {
              setQuestion(null)
              setAnswer('')
              setError(null)
            }}
            className="text-accent underline underline-offset-2"
          >
            Start again
          </button>
        </p>

        <p className="mt-8 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
          Repeated wrong answers lock this address for 15 minutes. If you cannot remember it, sign in
          with your password and set a new question from your account.
        </p>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Reset your password">
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        Give us the address on the account. We will show you the security question set on it.
      </p>

      <form onSubmit={askForQuestion} className="mt-7 space-y-4">
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
          {busy ? 'Looking…' : 'Continue'}
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
