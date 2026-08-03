import { Link } from 'react-router-dom'
import {
  useAuthStore,
  selectSignedIn,
  selectEmail,
  selectDisplayName,
} from '../../store/authStore'
import { useNameNoticeStore } from '../../store/nameNoticeStore'

/**
 * The one line that closes the display-name gap for one person, and all it can
 * do is ask.
 *
 * An account made before display names existed carries a null one, so
 * `identity()` on the server falls through to the address and every room it
 * joins is told the local part of it. Nothing here can invent a name on
 * somebody's behalf, and defaulting everyone to a generated animal would turn a
 * working roster into a zoo without being asked. What was actually missing is
 * that nobody was ever told it was happening unless they opened a 236px popover
 * they had no reason to open. This is that telling, once.
 *
 * **A guest is deliberately not shown it, although a guest's display name is
 * null too.** A guest has no address for the room to disclose, so they are
 * already an `Anonymous Quokka` to everybody and there is nothing to warn
 * about; the account menu offers them `Pick a name` permanently, which is an
 * invitation rather than a warning and is the right shape for that case. The
 * condition is therefore "has an address and no name", not "has no name".
 *
 * It says what the room currently calls you rather than that you should pick a
 * name, because the first is a fact somebody can act on and the second is an
 * instruction they can ignore.
 */
export default function NameNotice() {
  const signedIn = useAuthStore(selectSignedIn)
  const email = useAuthStore(selectEmail)
  const displayName = useAuthStore(selectDisplayName)
  const dismissed = useNameNoticeStore((s) => s.noticeDismissed)
  const dismiss = useNameNoticeStore((s) => s.dismissNotice)

  if (!signedIn || dismissed || displayName || !email) return null

  return (
    <div className="flex items-center gap-2 border-b border-rule bg-sunken/60 px-3 py-1.5 text-[11px] text-ink-3">
      <span className="flex-1">
        People sharing a board with you currently see you as{' '}
        <span className="font-mono text-ink-2">{email.split('@')[0]}</span>, taken from your email
        address.
      </span>
      {/* The link is centred explicitly and the button beside it is not, and
          that asymmetry is the point rather than an oversight: under the
          coarse-pointer floor both boxes become 44px tall, the UA stylesheet
          centres a `<button>`'s label for free, and nothing centres a link's.
          Without this the two words in this one row sat at different heights. */}
      <Link
        to="/name"
        className="inline-flex shrink-0 items-center justify-center font-medium text-accent
          hover:text-accent-hover"
      >
        Choose a name
      </Link>
      <button onClick={dismiss} className="shrink-0 font-medium text-ink-2 hover:text-ink">
        Got it
      </button>
    </div>
  )
}
