import { Link, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { Button, buttonClass } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { toast } from '../../store/toastStore'
import { toUserMessage } from '../../lib/errors'
import { CODE_LENGTH, cleanCode, joinPath } from '../../lib/joinCode'

/**
 * Signed-in state, and the one thing a guest needs to know: this board is not
 * being saved. Saving is what an account buys.
 */
export default function AccountMenu() {
  const email = useAuthStore((s) => s.email)
  const logOut = useAuthStore((s) => s.logOut)
  const deleteAccount = useAuthStore((s) => s.deleteAccount)
  const [params] = useSearchParams()

  if (!email) {
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

  const initial = email[0]?.toUpperCase() ?? '?'

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
          <p className="mt-1 truncate text-[13px] text-ink" title={email}>
            {email}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            Your boards are saved to your account.
          </p>
        </div>

        {/* The only entry point to it. Changing a password also re-sets the
            security question, which is the one thing that can get someone back
            in without it. Borrows the button's look rather than being one,
            because it navigates. */}
        <Link to="/password" className={buttonClass('secondary', 'w-full')}>
          Change password
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

        <Button
          variant="secondary"
          className="w-full border-accent/40 text-accent hover:border-accent"
          onClick={async () => {
            const ok = window.confirm(
              'Delete this account and every board saved under it? This cannot be undone.',
            )
            if (!ok) return
            try {
              await deleteAccount()
              toast('Account deleted, along with its saved boards.')
            } catch (err) {
              toast(toUserMessage(err, 'Could not delete the account. Try again.'))
            }
          }}
        >
          Delete account
        </Button>

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
