import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { toUserMessage } from '../../lib/errors'
import {
  useAuthStore,
  selectSignedIn,
  selectIsGuest,
  selectTwoFactorEnabled,
} from '../../store/authStore'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'

/**
 * Deleting the account, and every board saved under it.
 *
 * **A page rather than the `window.confirm` this used to be**, and the reason is
 * the one that made `/password` and `/sessions` pages. The server now requires
 * the current password here, and a code as well when two-step sign-in is on,
 * because deletion is the most destructive thing a session can ask for and it
 * was the one control on that router asking for less than its neighbours. A
 * native prompt cannot collect a password: it puts it on screen in clear text
 * where no password manager can fill it, and it cannot hold two fields at all.
 *
 * The confirmation is deliberately still here, in the sentence above the button
 * rather than as a second dialog. Typing your own password *is* the confirmation
 * step, and stacking a prompt on top of a credential is the pattern that trains
 * people to click through both.
 */
export default function DeleteAccountPage() {
  const navigate = useNavigate()
  const signedIn = useAuthStore(selectSignedIn)
  const isGuest = useAuthStore(selectIsGuest)
  const twoFactorEnabled = useAuthStore(selectTwoFactorEnabled)
  const ready = useAuthStore((s) => s.ready)
  const deleteAccount = useAuthStore((s) => s.deleteAccount)

  const [currentPassword, setCurrentPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * Whether the account is already gone, which the redirect below has to know.
   *
   * A successful deletion clears `user`, and without this the effect underneath
   * would see nobody signed in and send the person to `/login?next=/delete-account`:
   * a sign-in form, for an account that no longer exists, as the last thing they
   * are shown. The confirmation panel is also worth having on its own. This is
   * the one action with nothing left to look at afterwards, so saying plainly
   * that it happened is the only receipt there is.
   */
  const [done, setDone] = useState(false)
  /**
   * A deletion is in flight, so a disappearing user is the point rather than a
   * visitor arriving.
   *
   * A ref and not state, because of *when* it has to be true. `deleteAccount`
   * clears `user` in the store and only then returns, so React renders once with
   * nobody signed in and `done` still false, and the effect below fires in that
   * gap and navigates to the sign-in form. Setting this before the request means
   * the effect reads it as true on that very render. Cleared again if the server
   * refuses, so a wrong password leaves the page exactly as it found it.
   */
  const deleting = useRef(false)

  /**
   * Only a visitor is turned away, and a guest deliberately is not.
   *
   * `/password` and `/sessions` both send a guest to `/claim`, because both
   * change a credential a guest has not got. This one does not: the privacy
   * policy tells everybody they may withdraw consent by deleting their account
   * and excepts nobody, and the server admits a guest on the session alone
   * because that is the only credential such an account has. Sending them to
   * `/claim` would answer "I want this gone" with "give it an address first".
   *
   * Waiting for `ready` is what stops this bouncing everybody to the login page:
   * before the session has been checked, nobody looks signed in.
   */
  useEffect(() => {
    if (!ready || done || deleting.current) return
    if (!signedIn) navigate('/login?next=/delete-account', { replace: true })
  }, [ready, signedIn, done, navigate])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    deleting.current = true
    try {
      // A guest sends neither, which is what the optional arguments are for.
      await deleteAccount(
        isGuest ? undefined : currentPassword,
        twoFactorEnabled ? code : undefined,
      )
      setDone(true)
    } catch (err) {
      deleting.current = false
      // The server's own message is the useful one: a wrong password and a wrong
      // code are the two failures this form is meant to have and it names both.
      setError(toUserMessage(err, 'That did not work. Check what you typed and try again.'))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthShell title="Your account has been deleted">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          The account and every board saved under it are gone, and every session it had is closed.
          There is nothing left to sign in to and nothing to restore. Boards owned by other people
          that you were shared into are untouched.
        </p>
        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={() => navigate('/', { replace: true })}
          className={`mt-6 ${submitBtn}`}
        >
          Back to the start
        </motion.button>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Delete your account">
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        This removes your account and every board saved under it, straight away. There is no backup
        to restore them from and nobody here can undo it. Boards other people own that you were
        shared into are not affected, and they stay with their owners.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4">
        {/* A guest has no password on the row to confirm, so asking for one
            would be asking for something that cannot exist. The server refuses
            it from that side too, on the account rather than on what arrives. */}
        {!isGuest && (
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
        )}

        {twoFactorEnabled && (
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
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className={`${field} font-mono tracking-[0.18em]`}
            />
            {/* Said plainly, because somebody deleting an account under duress
                is exactly who needs to know the second lock still applies. */}
            <span className="mt-1.5 block text-[12px] leading-relaxed text-ink-3">
              Two-step sign-in is on, so a code from your authenticator app is needed here as well.
              A recovery code works too.
            </span>
          </label>
        )}

        {/* The same argument `/sessions` makes, and it matters more here: this is
            the one action nothing can reverse, so a held session must not be
            enough on its own. */}
        {!isGuest && (
          <p className="text-[12px] leading-relaxed text-ink-3">
            Your password is asked for so that somebody using your account cannot do this to you.
          </p>
        )}

        {isGuest && (
          <p className="text-[12px] leading-relaxed text-ink-3">
            This account was created by a join code and has no password, so there is nothing to
            confirm. If you meant to keep these boards instead, give the account an address and a
            password first.
          </p>
        )}

        {error && <FormError>{error}</FormError>}

        <motion.button
          type="submit"
          whileTap={{ scale: 0.98 }}
          disabled={busy}
          className={submitBtn}
        >
          {busy ? 'Deleting…' : 'Delete my account'}
        </motion.button>
      </form>

      {isGuest && (
        <p className="mt-5 text-[13px] text-ink-2">
          Changed your mind?{' '}
          <Link to="/claim" className="text-accent underline underline-offset-2">
            Keep these boards
          </Link>{' '}
          instead.
        </p>
      )}

      <p className="mt-3 text-[13px] text-ink-2">
        <Link to="/board" className="text-accent underline underline-offset-2">
          Back to the board
        </Link>
      </p>
    </AuthShell>
  )
}
