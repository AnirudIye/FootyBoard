import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { api } from '../../lib/api'
import type { LoginChallenge, SecurityQuestion } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'

/**
 * Recovery, steps one to two and a half. The new password is
 * `ResetPasswordPage`.
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
 *
 * **A correct answer on an account with a second factor buys a challenge and no
 * reset token at all.** The reset token is the credential, so the factor is
 * demanded in front of issuing one rather than in front of spending it: guarding
 * the use would put the code ahead of something already handed out, and
 * `POST /api/auth/sessions` voids pending reset tokens precisely because a live
 * one is a way in. That is the third panel below.
 */
export default function ForgotPasswordPage() {
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [question, setQuestion] = useState<SecurityQuestion | null>(null)
  const [answer, setAnswer] = useState('')
  /** The factor owed after a correct answer, when the account has one. */
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Back to the address, which is where a spent challenge has to start from. */
  const startOver = () => {
    setChallenge(null)
    setQuestion(null)
    setAnswer('')
    setCode('')
  }

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
      const { token, challenge: owed } = await api.verifySecurityAnswer(email, answer)
      // A challenge means no reset token was issued at all, so there is nothing
      // to carry forward yet and navigating would land on `/reset` holding null.
      if (owed) return setChallenge(owed)
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

  /**
   * Step two and a half, and the reason a refusal goes all the way back to the
   * address rather than leaving the field on screen.
   *
   * `POST /api/auth/forgot/2fa` claims the challenge before it compares the
   * code, so one challenge is worth exactly one guess and a second attempt on
   * the same token is refused however right the code is. Offering a retry would
   * be offering a box that cannot ever work, to somebody who is already locked
   * out and being told their code is wrong.
   *
   * The cost is real and is worth naming: starting again means answering the
   * security question again, and that allowance counts wrong answers. It is
   * still better than a form that cannot succeed.
   */
  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!challenge) return
    setError(null)
    setBusy(true)
    try {
      const { token } = await api.completeRecoveryTwoFactor(challenge.token, code)
      navigate('/reset', { replace: true, state: { token } })
    } catch (err) {
      startOver()
      setError(
        `${toUserMessage(err, 'That code did not work.')} A code prompt is good for one attempt, ` +
          'so this starts again from your address.',
      )
    } finally {
      setBusy(false)
    }
  }

  if (challenge) {
    return (
      <AuthShell title="One more step">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          This account uses two-step sign-in, so a code is needed here as well as the answer. Type
          the six digit code from your authenticator app, or one of your recovery codes.
        </p>

        <form onSubmit={submitCode} className="mt-7 space-y-4">
          <label className="block">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
              Code
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={19}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className={`${field} font-mono tracking-[0.18em]`}
            />
            {/* The minutes come off the response rather than being repeated
                here, so this page cannot drift from the server's own TTL. */}
            <span className="mt-1.5 block text-[12px] leading-relaxed text-ink-3">
              This step lasts {challenge.expiresInMinutes} minutes and takes one attempt.
            </span>
          </label>

          {error && <FormError>{error}</FormError>}

          <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
            {busy ? 'Checking…' : 'Continue'}
          </motion.button>
        </form>

        {/* Said here, before an attempt is spent, rather than left to a refusal
            to imply. An account with the factor on, no authenticator and no
            unused recovery codes cannot be recovered from this page by anybody,
            and that is an accepted cost rather than a defect, which is exactly
            what makes saying it out loud part of the feature. */}
        <p className="mt-8 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
          We cannot skip this step. If you have lost both your authenticator app and your recovery
          codes, nobody can restore access from this page, because a reset that skipped the code
          would leave your security question as the only lock on the account.
        </p>

        <p className="mt-4 text-[13px] text-ink-2">
          Wrong address?{' '}
          <button
            type="button"
            onClick={() => {
              startOver()
              setError(null)
            }}
            className="text-accent underline underline-offset-2"
          >
            Start again
          </button>
        </p>
      </AuthShell>
    )
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
