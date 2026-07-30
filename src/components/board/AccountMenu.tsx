import { Link, useSearchParams } from 'react-router-dom'
import {
  useAuthStore,
  selectSignedIn,
  selectEmail,
  selectIsGuest,
  selectDisplayName,
  selectTwoFactorEnabled,
} from '../../store/authStore'
import { Button, buttonClass } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { toast } from '../../store/toastStore'
import { toUserMessage } from '../../lib/errors'
import { CODE_LENGTH, cleanCode, joinPath } from '../../lib/joinCode'

/**
 * Three states, not two, and the middle one is the newest.
 *
 * Nobody signed in: this board is not being saved, and saving is what an account
 * buys. A guest admitted by a join code: the board *is* saved, and the thing they
 * need to know is the opposite one, that there is no way back into the account
 * holding it. A real account: the ordinary menu.
 */
export default function AccountMenu() {
  const signedIn = useAuthStore(selectSignedIn)
  const email = useAuthStore(selectEmail)
  const isGuest = useAuthStore(selectIsGuest)
  const displayName = useAuthStore(selectDisplayName)
  const twoFactorEnabled = useAuthStore(selectTwoFactorEnabled)
  const logOut = useAuthStore((s) => s.logOut)
  const [params] = useSearchParams()

  if (!signedIn) {
    /**
     * A guest who came through the join flow arrives at `/board?join=CODE`,
     * which is this end of the carry the auth pages promised. Without it the
     * code really is gone: the guest board offers no way back to `/join`, so
     * the only route left is retyping the code somebody read out once.
     *
     * The label changes with it. "Save your board" would be the wrong promise
     * here, because signing up from this state does not keep this board, it
     * finishes the join and opens the shared one.
     */
    const pendingCode = cleanCode(params.get('join') ?? '')
    const joining = pendingCode.length === CODE_LENGTH

    return (
      <div className="flex items-center gap-2">
        {/* The one place a guest is told this, next to the thing that fixes it.
            The save indicator holds its tongue until there is an account. */}
        <span
          title={
            joining
              ? 'Your join code is still waiting. An account is what it attaches to.'
              : 'Sign in and your boards are kept. As a guest nothing is saved.'
          }
          className="hidden font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3 lg:inline"
        >
          Not saving
        </span>
        <Link
          to={joining ? `/signup?next=${encodeURIComponent(joinPath(pendingCode))}` : '/signup'}
          className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium leading-none text-paper
            transition-colors duration-150 hover:bg-accent-hover
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-accent"
        >
          {joining ? 'Sign up and join' : 'Save your board'}
        </Link>
      </div>
    )
  }

  /**
   * A guest is signed in, is saving, and has no way back.
   *
   * The account was handed out by a join code and has no address and no
   * password, so the session cookie in this browser is the only route to it and
   * every board saved under it goes when that cookie does. That is the one thing
   * worth a permanent control rather than a toast, so it gets the primary button
   * and the plain sentence: this is the mitigation for the trap guest admission
   * would otherwise be, not a nudge towards signing up.
   *
   * "Not saving" is deliberately absent, unlike the signed-out state above. This
   * board really is being saved, and repeating that warning here would be the
   * indicator lying in the one place a coach reads to ask.
   */
  if (isGuest) {
    return (
      <div className="flex items-center gap-2">
        <span
          title="This account was made by your join code. It has no password, so it only exists in this browser."
          className="hidden font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3 lg:inline"
        >
          Guest
        </span>
        {/* A guest has no popover to put this in, and is the person it helps
            most: with no address there is nothing for the room to fall back to,
            so before this they could only ever be Anonymous Something. Quiet
            rather than a second primary button, because keeping the boards is
            still the thing that matters more. */}
        <Link
          to="/name"
          title={
            displayName
              ? `Boards call you ${displayName}. Change it here.`
              : 'Choose what other people on a board see instead of a made-up name.'
          }
          className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3
            transition-colors hover:text-accent"
        >
          {displayName ? 'Your name' : 'Pick a name'}
        </Link>
        {/* `/delete-account` is deliberately not linked here, and that is a
            decision rather than an omission. The page and the server both admit
            a guest: the row has no password to confirm, so demanding one would
            make deletion impossible rather than harder, and the privacy policy
            promises it to everybody. What this bar will not do is put the
            control that destroys the account next to the one that saves it, in a
            three-item row with no popover to separate them. A guest who wants it
            can reach `/delete-account` directly. If that ever needs advertising,
            it belongs behind the same popover a signed-in account gets, not as a
            fourth item here. */}
        <Link
          to="/claim"
          className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium leading-none text-paper
            transition-colors duration-150 hover:bg-accent-hover
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-accent"
        >
          Keep these boards
        </Link>
      </div>
    )
  }

  const initial = email?.[0]?.toUpperCase() ?? '?'

  return (
    <Popover
      align="right"
      className="w-[236px]"
      triggerClassName="gap-2 pl-2"
      trigger={
        <>
          <span className="grid h-5 w-5 place-items-center rounded-full bg-accent font-mono text-[11px] text-paper">
            {initial}
          </span>
          Account
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">Signed in</p>
          <p className="mt-1 truncate text-[13px] text-ink" title={email ?? undefined}>
            {email}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            Your boards are saved to your account.{' '}
            {displayName
              ? `Other people on a board see you as ${displayName}.`
              : 'Other people on a board see your email address.'}
          </p>
        </div>

        {/* Beside the password change, because both are "settings for this
            account" and there is nowhere else to reach either of them.
            The label changes on whether there is a name yet, and the sentence
            above says which state you are in: an account made before display
            names existed has none, and what a room falls back to is the address.
            That is known gap 2, and this is the control that closes it for one
            person. */}
        <Link to="/name" className={buttonClass('secondary', 'w-full')}>
          {displayName ? 'Change display name' : 'Choose a display name'}
        </Link>

        {/* The only entry point to it. Changing a password also re-sets the
            security question, which is the one thing that can get someone back
            in without it. Borrows the button's look rather than being one,
            because it navigates. */}
        <Link to="/password" className={buttonClass('secondary', 'w-full')}>
          Change password
        </Link>

        {/* Between the password change and the session control, because it is
            the third thing in the same family and it sits in strength order:
            change the password, add a second lock, throw everybody out.

            The label is the state rather than an invitation, so somebody who has
            already turned it on is not asked to again and can still get at the
            recovery-code count behind it. It reads `twoFactorEnabled` off the
            user object, which the server derives from `totp_confirmed_at`, so an
            enrollment somebody abandoned halfway reads as off, which it is.

            The guest and signed-out branches above are deliberately untouched: a
            guest has no password, so there is nothing for a factor to sit
            behind, and `/2fa` sends one to `/claim` for that reason. */}
        <Link to="/2fa" className={buttonClass('secondary', 'w-full')}>
          {twoFactorEnabled ? 'Two-step sign-in is on' : 'Turn on two-step sign-in'}
        </Link>

        {/* Beside the control above rather than inside it: changing a password
            ends every session as a side effect, and for a while that was the
            only way to end them, so anybody who suspected a session had been
            taken had to invent a new password to throw it out.

            A link for a stronger reason than matching: this destroys the session
            it was asked from, so a board still mounted would watch its own room
            close and announce a session that has ended, over a browser the
            server signed back in a moment earlier. The page it leads to holds no
            room. A guest never reaches this popover, which is what keeps both
            credential controls away from an account that has no password. */}
        <Link to="/sessions" className={buttonClass('secondary', 'w-full')}>
          Sign out everywhere
        </Link>

        <Button
          onClick={async () => {
            try {
              await logOut()
            } catch (err) {
              toast(toUserMessage(err, 'Could not sign out. Try again.'))
            }
          }}
          className="w-full"
        >
          Sign out
        </Button>

        {/* A link to a page, where it used to be a button behind
            `window.confirm`. The server asks for the current password now, and
            for a code when the factor is on, which is what its two neighbours
            have always asked for and what deletion alone was not. A native
            confirm cannot collect a credential: it holds one line of text, puts
            it on screen in clear text, and no password manager can fill it. The
            confirmation did not go away, it moved onto that page, where typing
            your own password is the confirmation rather than a dialog stacked on
            top of one. */}
        <Link
          to="/delete-account"
          className={buttonClass('secondary', 'w-full border-accent/40 text-accent hover:border-accent')}
        >
          Delete account
        </Link>

        <nav className="flex gap-4 border-t border-rule pt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">
          <Link to="/privacy" className="transition-colors hover:text-accent">
            Privacy
          </Link>
          <Link to="/terms" className="transition-colors hover:text-accent">
            Terms
          </Link>
        </nav>
      </div>
    </Popover>
  )
}
