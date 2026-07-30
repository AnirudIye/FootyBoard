import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { toUserMessage } from '../../lib/errors'
import {
  useAuthStore,
  selectSignedIn,
  selectIsGuest,
  selectDisplayName,
} from '../../store/authStore'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'
import SecurityQuestionFields, { useSecurityQuestions } from './SecurityQuestionFields'

/**
 * Giving a guest account a way back into itself.
 *
 * A join code admits somebody without an account, which is the point, and it
 * leaves them holding one that has no address and no password: the session
 * cookie in this browser is the only route to it, and every board saved under it
 * goes when that cookie does. This page is the way out of that, and it is not a
 * nicety — without it, guest admission is a mechanism for losing work.
 *
 * **It is deliberately not the signup form.** Signing up would create a second
 * account and leave the boards behind on the first, which is exactly the failure
 * it would look like it was fixing. The fields are the same and the endpoint is
 * not: `/auth/claim` sets credentials on the account already holding the work.
 */
export default function ClaimPage() {
  const navigate = useNavigate()
  const signedIn = useAuthStore(selectSignedIn)
  const isGuest = useAuthStore(selectIsGuest)
  const ready = useAuthStore((s) => s.ready)
  const claim = useAuthStore((s) => s.claim)
  // A guest may already have chosen a name from `/name`, and claiming must not
  // quietly take it away. Seeding the field with it means the form states what is
  // already true rather than asking the same question twice.
  const currentName = useAuthStore(selectDisplayName)
  const { questions, failed } = useSecurityQuestions()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [questionId, setQuestionId] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Only a guest has anything to claim.
   *
   * Waiting on `ready` matters for the same reason it does on the password page:
   * before the session has been checked nobody looks signed in, including the
   * people who are, and redirecting on that would bounce every guest who
   * followed this link straight back out again.
   */
  useEffect(() => {
    if (!ready) return
    if (!signedIn) navigate('/signup', { replace: true })
    else if (!isGuest) navigate('/password', { replace: true })
  }, [ready, signedIn, isGuest, navigate])

  /**
   * Seeded when the name arrives rather than at mount, because `restore` has
   * usually not answered yet on the first render and a guest who reached here
   * from `/name` would find the field they just filled in empty again.
   *
   * Only into an empty field: overwriting something already typed would be worse
   * than not seeding at all.
   */
  useEffect(() => {
    if (currentName) setDisplayName((typed) => typed || currentName)
  }, [currentName])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await claim(email, password, accepted, questionId, answer, displayName)
      // Straight back to the board. Nothing moved, nothing reloaded: it is the
      // same account and the same boards, now with a way back into them.
      navigate('/board', { replace: true })
    } catch (err) {
      setError(toUserMessage(err, 'That did not work. Check the details and try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Keep these boards">
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        You joined with a code, so this account has no password yet and only exists in this
        browser. Set an email and password and everything you have made stays yours. Nothing
        moves, and you do not lose the board you are on.
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

        <label className="block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
            Password
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

        {/* Asked here for a reason particular to claiming: this account is
            gaining an address, and presence falls back to the address when there
            is no name. Somebody the room has been calling Anonymous Quokka all
            session would otherwise become their own email the moment they kept
            their boards. */}
        <label className="block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
            Display name
          </span>
          <input
            type="text"
            autoComplete="nickname"
            required
            maxLength={60}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Coach Ade"
            className={field}
          />
          <span className="mt-1.5 block text-[12px] leading-relaxed text-ink-3">
            What everyone else on a board sees. Without one, the email you just set would be shown
            to them instead.
          </span>
        </label>

        {/* The only way back in if this password is forgotten, so it is set here
            rather than offered later. There is no reset email to fall back on. */}
        <SecurityQuestionFields
          questions={questions}
          failed={failed}
          questionId={questionId}
          onQuestionId={setQuestionId}
          answer={answer}
          onAnswer={setAnswer}
        />

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

        {error && <FormError>{error}</FormError>}

        <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
          {busy ? 'Working…' : 'Keep these boards'}
        </motion.button>
      </form>

      <p className="mt-5 text-[13px] text-ink-2">
        <Link to="/board" className="text-accent underline underline-offset-2">
          Back to the board
        </Link>
      </p>

      <p className="mt-8 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
        Your password is hashed before it is stored, and never kept in readable form. So is the
        answer to your security question, which is what proves it is you if you forget the
        password.
      </p>
    </AuthShell>
  )
}
