import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { api } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { useAuthStore, selectSignedIn, selectIsGuest } from '../../store/authStore'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'

/**
 * Ending every session on the account, and changing nothing else.
 *
 * The control for the moment somebody thinks another person is in their account.
 * Until this existed the only thing that signed every session out was
 * `/password`, which required a new password on the way, so throwing an intruder
 * out cost a credential change nobody had asked for.
 *
 * **A page rather than something the account menu does where it stands**, and the
 * reason is the same one that made `/password` a page. This deliberately destroys
 * the session it was asked from, which closes that browser's live room: done from
 * the board, the room announces "your session has ended, sign in again" and the
 * save indicator drops to "not saving", and both of those are false about a
 * browser holding a session the server minted a second earlier. Off the board
 * there is no room to close, and going back mounts a fresh one on the new cookie.
 * It also wants a real password field, which a native prompt is not: that puts a
 * credential on screen in clear text where no password manager can fill it.
 *
 * One field, so the paragraph above it is doing most of the work. It has to say
 * which of the two things happened, because "signed out everywhere" and "password
 * changed" are a step apart and the whole point of this page is that it is only
 * the first.
 */
export default function SignOutEverywherePage() {
  const navigate = useNavigate()
  const signedIn = useAuthStore(selectSignedIn)
  /**
   * A guest is sent to claim their account instead, exactly as `/password` does
   * it. There is no password on that row to confirm and nothing to revoke: a
   * guest account has one session and it is this browser. What they actually want
   * is credentials on the account holding their boards, and the server refuses
   * this either way.
   */
  const isGuest = useAuthStore(selectIsGuest)
  const ready = useAuthStore((s) => s.ready)

  const [currentPassword, setCurrentPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  // Waiting for `ready` is what stops this bouncing everybody to the login page:
  // before the session has been checked, nobody looks signed in.
  useEffect(() => {
    if (!ready) return
    if (!signedIn) navigate('/login?next=/sessions', { replace: true })
    else if (isGuest) navigate('/claim', { replace: true })
  }, [ready, signedIn, isGuest, navigate])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.signOutEverywhere(currentPassword)
      setDone(true)
    } catch (err) {
      // The server's own message is the useful one here: a wrong password is the
      // failure this endpoint is meant to have, and it says so precisely.
      setError(toUserMessage(err, 'That did not work. Check your password and try again.'))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthShell title="Signed out everywhere">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          Every session on this account has ended, on every device, and any live board they were
          in has been closed. Your password has not changed. This browser is still signed in, on a
          new session of its own.
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
    <AuthShell title="Sign out everywhere">
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        This ends every session on your account, on every device, and closes any live board they
        are in. Your password stays exactly as it is, and this browser stays signed in.
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

        {/* Asked for the same reason `/password` asks: a session left open on a
            shared machine must not be enough to sign its owner out of everywhere
            else, or this control is a gift to the person it exists to remove. */}
        <p className="text-[12px] leading-relaxed text-ink-3">
          Your password is asked for so that somebody using your account cannot do this to you.
        </p>

        {error && <FormError>{error}</FormError>}

        <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
          {busy ? 'Signing out…' : 'Sign out everywhere'}
        </motion.button>
      </form>

      {/* The dead end this avoids: somebody who believes they have been robbed
          and cannot remember their password has no way through this form, and
          `/password` asks for the same thing. Recovery is the door that takes an
          answer instead, and it ends every session on the way. */}
      <p className="mt-5 text-[13px] text-ink-2">
        Cannot remember it?{' '}
        <Link to="/forgot" className="text-accent underline underline-offset-2">
          Recover your account
        </Link>{' '}
        instead, which also ends every session.
      </p>

      <p className="mt-3 text-[13px] text-ink-2">
        <Link to="/board" className="text-accent underline underline-offset-2">
          Back to the board
        </Link>
      </p>
    </AuthShell>
  )
}
