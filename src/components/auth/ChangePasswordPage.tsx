import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { api } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { useAuthStore, selectSignedIn, selectIsGuest } from '../../store/authStore'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'
import SecurityQuestionFields, { useSecurityQuestions } from './SecurityQuestionFields'

/**
 * Changing a password while signed in, which also re-sets the security
 * question.
 *
 * Both, always. The question is the only route back into an account whose
 * password has gone, so the moment someone is in front of their account and
 * thinking about credentials is the moment to confirm they still know the
 * answer to it. Offering it as optional would mean nobody ever touched it and
 * recovery would keep resting on whatever was typed at signup.
 *
 * A page rather than a panel in the account menu: it is four fields and a
 * paragraph of consequence, and the popover it would otherwise live in is
 * 236px wide.
 */
export default function ChangePasswordPage() {
  const navigate = useNavigate()
  const signedIn = useAuthStore(selectSignedIn)
  // The one page where "has credentials" is the real question rather than "is
  // signed in". A guest has neither a current password to confirm nor a stored
  // one to replace, so the form cannot be completed and the server refuses it;
  // sending them to the claim page is the same request they actually mean.
  const isGuest = useAuthStore(selectIsGuest)
  const ready = useAuthStore((s) => s.ready)
  const { questions, failed } = useSecurityQuestions()

  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [questionId, setQuestionId] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  // Nothing here is usable signed out, and the server would refuse it anyway.
  // Waiting for `ready` matters: before the session has been checked, nobody
  // looks signed in, including the people who are.
  useEffect(() => {
    if (!ready) return
    if (!signedIn) navigate('/login?next=/password', { replace: true })
    else if (isGuest) navigate('/claim', { replace: true })
  }, [ready, signedIn, isGuest, navigate])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Checked here purely for a quicker answer; the server enforces the rest.
    if (password !== confirm) return setError('Those two passwords do not match.')
    setError(null)
    setBusy(true)
    try {
      await api.changePassword(currentPassword, password, questionId, answer)
      setDone(true)
    } catch (err) {
      setError(toUserMessage(err, 'That did not work. Check the details and try again.'))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthShell title="Password changed">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          Your new security question is saved too. Everywhere else that was signed in to this
          account has been signed out; this browser is still signed in.
        </p>
        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={() => navigate('/board')}
          className={`mt-6 ${submitBtn}`}
        >
          Back to the board
        </motion.button>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Change your password">
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        Set a new password, and confirm the security question that gets you back in if you forget
        it.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4">
        <label className="block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
            Current password
          </span>
          <input
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className={field}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
            New password
          </span>
          <input
            type="password"
            autoComplete="new-password"
            required
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

        <SecurityQuestionFields
          questions={questions}
          failed={failed}
          questionId={questionId}
          onQuestionId={setQuestionId}
          answer={answer}
          onAnswer={setAnswer}
        />

        {error && <FormError>{error}</FormError>}

        <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
          {busy ? 'Saving…' : 'Save the new password'}
        </motion.button>
      </form>

      <p className="mt-5 text-[13px] text-ink-2">
        <Link to="/board" className="text-accent underline underline-offset-2">
          Back to the board
        </Link>
      </p>
    </AuthShell>
  )
}
