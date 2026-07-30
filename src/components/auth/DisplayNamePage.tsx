import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { toUserMessage } from '../../lib/errors'
import {
  useAuthStore,
  selectSignedIn,
  selectEmail,
  selectDisplayName,
} from '../../store/authStore'
import { AuthShell, field, submitBtn, FormError } from './AuthShell'

/**
 * Choosing what a room calls you.
 *
 * Signup and `/claim` are where this is *required*, and they are what make every
 * new account safe by construction. This page exists for the two cases those two
 * cannot reach: an account created before display names existed, which is still
 * showing its address to every room it joins, and anybody who simply wants a
 * different name than the one they picked.
 *
 * **Deliberately open to a guest**, unlike `/password`, which sends one away
 * because it needs a current password to verify and a guest has none. Nothing here
 * is a credential, and a guest is the person this helps most: with no address, the
 * room could only ever call them Anonymous Quokka.
 *
 * A page rather than a field in the account popover, following the password
 * change: it is a field, a paragraph of consequence and a confirmation, and the
 * popover it would otherwise live in is 236px wide.
 */
export default function DisplayNamePage() {
  const navigate = useNavigate()
  const signedIn = useAuthStore(selectSignedIn)
  const ready = useAuthStore((s) => s.ready)
  const email = useAuthStore(selectEmail)
  const current = useAuthStore(selectDisplayName)
  const setDisplayName = useAuthStore((s) => s.setDisplayName)

  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  // Nothing here is usable signed out, and the server refuses it anyway. Waiting
  // for `ready` matters: before the session has been checked nobody looks signed
  // in, including the people who are.
  useEffect(() => {
    if (!ready) return
    if (!signedIn) navigate('/login?next=/name', { replace: true })
  }, [ready, signedIn, navigate])

  /**
   * The field starts as whatever the name already is, so this is a change rather
   * than a re-invention. Seeded when the account arrives rather than at mount,
   * because `restore` has usually not answered on the first render, and only into
   * an untouched field so it cannot overwrite something typed in the meantime.
   */
  useEffect(() => {
    if (current) setName((typed) => typed || current)
  }, [current])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await setDisplayName(name)
      setDone(true)
    } catch (err) {
      setError(toUserMessage(err, 'That did not work. Try a different name.'))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthShell title="Name saved">
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          Boards you open from now on will call you {current}. A board that is already open in
          another tab keeps the old name until it reconnects.
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
    <AuthShell title="Your display name">
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        This is what everyone else on a board sees, beside your cursor and in the list of who is
        here.
      </p>

      {/* The state this page exists for, said plainly rather than implied by an
          empty field. An account made before display names existed has none, and
          what the room falls back to is the address, so somebody who has never
          been asked deserves to know that is what is happening. */}
      {!current && email && (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
          You have not chosen one yet, so rooms currently name you {email.split('@')[0]}, from your
          email address.
        </p>
      )}
      {!current && !email && (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
          You joined with a code, so rooms currently give you a made-up name like Anonymous Quokka.
          A name you choose is used instead.
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-7 space-y-4">
        <label className="block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
            Display name
          </span>
          <input
            type="text"
            autoComplete="nickname"
            required
            autoFocus
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Coach Ade"
            className={field}
          />
        </label>

        {error && <FormError>{error}</FormError>}

        <motion.button type="submit" whileTap={{ scale: 0.98 }} disabled={busy} className={submitBtn}>
          {busy ? 'Saving…' : 'Save this name'}
        </motion.button>
      </form>

      <p className="mt-5 text-[13px] text-ink-2">
        <Link to="/board" className="text-accent underline underline-offset-2">
          Back to the board
        </Link>
      </p>

      {/* Two costs, both real. The owner's switch outranks this, and the owner's
          own list is a different question from the room's. */}
      <p className="mt-8 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
        A board whose owner has turned on anonymous guests shows a made-up name to everyone,
        including you, whatever you choose here. The owner of a board you join can always see the
        email address on your account.
      </p>
    </AuthShell>
  )
}
