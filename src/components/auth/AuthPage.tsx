import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { api } from '../../lib/api'
import type { LoginChallenge } from '../../lib/api'
import { useAuthStore } from '../../store/authStore'
import { useBoardsStore } from '../../store/boardsStore'
import { toUserMessage } from '../../lib/errors'
import { codeInNext } from '../../lib/joinCode'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'
import SecurityQuestionFields, { useSecurityQuestions } from './SecurityQuestionFields'

type Mode = 'signup' | 'login'

/**
 * Where to go once the account exists.
 *
 * Only same-origin paths are honoured. `next` arrives in the URL, so anyone can
 * put anything in it, and sending someone to an absolute URL after they sign in
 * is an open redirect: a link to our own login page could land them on a
 * convincing copy of it. A value that does not start with a single `/` is
 * ignored rather than corrected, and `//host` is rejected too because the
 * browser reads it as protocol-relative and would leave the site.
 */
const safeNext = (raw: string | null): string | null =>
  raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : null

const guestLink = 'underline underline-offset-2 transition-colors hover:text-accent'

export default function AuthPage({ mode }: { mode: Mode }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const signUp = useAuthStore((s) => s.signUp)
  const logIn = useAuthStore((s) => s.logIn)
  const completeTwoFactor = useAuthStore((s) => s.completeTwoFactor)
  const next = safeNext(params.get('next'))

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [questionId, setQuestionId] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * The half-finished sign-in, when there is one.
   *
   * Non-null means the password was right and no session was minted, so this is
   * the only thing standing between here and the account. It is deliberately
   * component state and nothing more: the server sends it in the response body
   * rather than a cookie precisely so it lives in one page's memory, and a
   * reload is meant to send somebody back to the password rather than resume.
   */
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null)
  const [code, setCode] = useState('')

  const isSignup = mode === 'signup'
  const { questions, failed } = useSecurityQuestions()

  /**
   * The guest door, which now goes where the person was actually trying to go.
   *
   * It used to hand them a blank board of their own and carry the code along for
   * later, on the argument that membership attaches to a person rather than to a
   * browser. Carrying the code was better than losing it and it was still not
   * what anybody came for, and the argument does not survive reading
   * `POST /api/auth/signup`: it verifies no address at all, so the account gate
   * stopped nobody who wanted through it. It was a constraint on the users table,
   * not a barrier. A guest gets an account now, with no address and no password,
   * and real membership of the board the code names.
   *
   * A share token still cannot travel. It is a credential rather than six letters
   * read off a screen, `useShareLink` strips it from the address bar for exactly
   * that reason, and there is no equivalent of "redeem this without an account"
   * that would not put it back in a URL. That case keeps the sentence and the
   * blank board.
   */
  const pendingCode = codeInNext(next)
  const shareNext = pendingCode === null && (next?.startsWith('/board?') ?? false)

  const [guestBusy, setGuestBusy] = useState(false)

  const continueAsGuest = async () => {
    if (!pendingCode || guestBusy) return
    setGuestBusy(true)
    setError(null)
    try {
      const { board } = await api.joinAsGuest(pendingCode)
      // The session cookie came back on that response, so the board is ours to
      // open. `restore` is what turns it into signed-in state for the rest of
      // the app, and it has to happen before navigating or the board page
      // mounts as nobody and loads nothing.
      await useAuthStore.getState().restore()
      useBoardsStore.getState().select(board.id)
      navigate('/board', { replace: true })
    } catch (err) {
      setGuestBusy(false)
      setError(toUserMessage(err, 'That code did not work. Check it and try again.'))
    }
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (isSignup) {
        await signUp(email, password, accepted, questionId, answer, displayName)
      } else {
        const pending = await logIn(email, password)
        // A correct password on an account with a second factor buys this and
        // nothing else: no session exists yet, on this side or the server's, so
        // navigating would mount a board page as nobody.
        if (pending) return setChallenge(pending)
      }
      // Both branches honour `next`, not just sign-in. Someone who was read a
      // code and does not have an account yet goes signup -> board-they-were
      // -invited-to, rather than signup -> an empty board with their code lost
      // somewhere behind them.
      navigate(next ?? '/board', { replace: true })
    } catch (err) {
      setError(toUserMessage(err, 'That did not work. Check the details and try again.'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * The second step, and the reason a refusal is not answered by leaving the
   * field on screen.
   *
   * `POST /api/auth/login/2fa` claims the challenge **before** it compares the
   * code, so one challenge is worth exactly one guess and a second attempt on
   * the same token is refused however right the code is. A retry box there would
   * fail every time, and the person would reasonably conclude their authenticator
   * had stopped working rather than that they had to start again.
   *
   * So the refusal drops the challenge and says why the form moved. The password
   * is deliberately left in state: they are about to need it again this second,
   * it is behind a password field either way, and clearing it would be friction
   * at the exact moment somebody is already frustrated.
   */
  const onSubmitCode = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!challenge) return
    setError(null)
    setBusy(true)
    try {
      await completeTwoFactor(challenge.token, code)
      navigate(next ?? '/board', { replace: true })
    } catch (err) {
      setChallenge(null)
      setCode('')
      setError(
        `${toUserMessage(err, 'That code did not work.')} A code prompt is good for one attempt, ` +
          'which is why this is the sign-in form again.',
      )
    } finally {
      setBusy(false)
    }
  }

  if (challenge) {
    return (
      <AuthShell title="Enter your code">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          Open your authenticator app and type the six digit code it is showing. A recovery code
          works here too.
        </p>

        <form onSubmit={onSubmitCode} className="mt-7 space-y-4">
          <label className="block">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
              Code
            </span>
            {/* Not `type="number"`, which strips a leading zero and draws
                spinners on a value that is not a quantity. `one-time-code` is
                what lets a phone offer the code from the notification, and the
                length allows a hyphenated recovery code as well as six digits. */}
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
            {/* The minutes come off the response rather than being written down
                here, so the page cannot drift from the server's own TTL. The
                second sentence is the honest half: the step really is worth one
                attempt, and saying so beforehand is cheaper than explaining it
                after a mistyped digit. */}
            <span className="mt-1.5 block text-[12px] leading-relaxed text-ink-3">
              This step lasts {challenge.expiresInMinutes} minutes and takes one attempt. If the
              code is refused you start again from your password.
            </span>
          </label>

          {error && <FormError>{error}</FormError>}

          <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
            {busy ? 'Checking…' : 'Sign in'}
          </motion.button>
        </form>

        <p className="mt-5 text-[13px] text-ink-2">
          Wrong account?{' '}
          <button
            type="button"
            onClick={() => {
              setChallenge(null)
              setCode('')
              setError(null)
            }}
            className="text-accent underline underline-offset-2"
          >
            Start again
          </button>
        </p>

        <p className="mt-8 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
          Lost your authenticator? Use one of the recovery codes you saved when you turned this on.
          Each one works once.
        </p>
      </AuthShell>
    )
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

        {/* Asked here rather than offered later, because the alternative is not
            "no name" but "your email address": presence falls back to the
            address, so an account that reaches a room without a name shows its
            local part to everybody in it. A field on this form is what makes
            every new account safe without anyone having to think about it. */}
        {isSignup && (
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
              What everyone else on a board sees, next to your cursor. Your email address is not
              shown to them.
            </span>
          </label>
        )}

        {/* The only way back in if this password is forgotten, so it is set
            here rather than offered later. There is no reset email to fall
            back on. */}
        {isSignup && (
          <SecurityQuestionFields
            questions={questions}
            failed={failed}
            questionId={questionId}
            onQuestionId={setQuestionId}
            answer={answer}
            onAnswer={setAnswer}
          />
        )}

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
        {/* `next` rides across the switch. Someone who arrived here holding a
            join code and then realises they need the other form would otherwise
            lose the code by clicking this link. */}
        <Link
          to={`${isSignup ? '/login' : '/signup'}${next ? `?next=${encodeURIComponent(next)}` : ''}`}
          className="text-accent underline underline-offset-2"
        >
          {isSignup ? 'Sign in' : 'Create one'}
        </Link>
      </p>

      <p className="mt-8 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
        Your password is hashed before it is stored, and never kept in readable form. So is the
        answer to your security question, which is what proves it is you if you forget the password.
      </p>

      {pendingCode ? (
        <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
          <button
            type="button"
            onClick={continueAsGuest}
            disabled={guestBusy}
            className={guestLink}
          >
            {guestBusy ? 'Joining…' : 'Continue as a guest'}
          </button>{' '}
          and you go straight to the board your code names. Your work is saved, but the account it
          is saved to has no password, so it lives in this browser only until you give it one.
        </p>
      ) : shareNext ? (
        <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
          Opening a shared link needs an account, because the link is a credential and cannot be
          redeemed without one.{' '}
          <Link to="/board" className={guestLink}>
            Continue as a guest
          </Link>{' '}
          and you get a board of your own instead, which is never saved, and you do not join the one
          you were opening.
        </p>
      ) : (
        <p className="mt-4 text-[12px] text-ink-3">
          <Link to="/board" className={guestLink}>
            Continue as a guest
          </Link>{' '}
          for a full board that is never saved.
        </p>
      )}
    </AuthShell>
  )
}
