import { Link } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { toast } from '../../store/toastStore'
import { toUserMessage } from '../../lib/errors'

/**
 * Signed-in state, and the one thing a guest needs to know: this board is not
 * being saved. Saving is what an account buys.
 */
export default function AccountMenu() {
  const email = useAuthStore((s) => s.email)
  const logOut = useAuthStore((s) => s.logOut)
  const deleteAccount = useAuthStore((s) => s.deleteAccount)

  if (!email) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3 lg:inline">
          Not saving
        </span>
        <Link
          to="/signup"
          className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium leading-none text-paper
            transition-colors duration-150 hover:bg-accent-hover
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-accent"
        >
          Save your board
        </Link>
      </div>
    )
  }

  const initial = email[0]?.toUpperCase() ?? '?'

  return (
    <Popover
      align="right"
      className="w-[236px]"
      trigger={
        <Button variant="secondary" className="gap-2 pl-2">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-accent font-mono text-[11px] text-paper">
            {initial}
          </span>
          Account
        </Button>
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
