import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { CODE_LENGTH, cleanCode as clean, joinPath } from '../../lib/joinCode'
import { useAuthStore, selectSignedIn } from '../../store/authStore'
import { useBoardsStore } from '../../store/boardsStore'
import { AuthShell } from '../auth/AuthShell'
import { Button } from '../ui/Button'

/**
 * Joining a board by typing the code someone read out.
 *
 * Deliberately a page of its own rather than a field tucked into the board:
 * the person arriving has usually been told "go to FootyBoard and put in
 * ABCDEF", and the thing they land on should be that box and almost nothing
 * else.
 */

export default function JoinPage() {
  // A guest has an account, so a guest can redeem a code like anybody else.
  const signedIn = useAuthStore(selectSignedIn)
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const [code, setCode] = useState(() => clean(params.get('code') ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const redeemed = useRef(false)

  const redeem = useCallback(
    async (value: string) => {
      setBusy(true)
      setError(null)
      try {
        const { board } = await api.joinWithCode(value)
        // The board was not ours a moment ago, so the picker has not heard of it.
        await useBoardsStore.getState().load()
        useBoardsStore.getState().select(board.id)
        navigate('/board', { replace: true })
      } catch (err) {
        setError(toUserMessage(err, 'That code is not valid. Check it and try again.'))
        setBusy(false)
      }
    },
    [navigate],
  )

  /**
   * Finish the journey the person already started.
   *
   * Someone who typed a code, was sent away to make an account, and came back
   * has said "join this board" once already. Landing them on the same form with
   * their own code sitting in it, waiting for a second press, reads as though
   * the first one did not take. So a code that arrived in the URL redeems
   * itself as soon as there is an account to attach it to.
   *
   * The ref, not the busy flag, is what stops this firing twice: a failure sets
   * `busy` back to false and the effect would otherwise retry a code the server
   * has already refused, forever.
   */
  useEffect(() => {
    const fromUrl = clean(params.get('code') ?? '')
    if (!signedIn || redeemed.current || fromUrl.length !== CODE_LENGTH) return
    redeemed.current = true
    void redeem(fromUrl)
  }, [signedIn, params, redeem])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (code.length !== CODE_LENGTH || busy) return

    // Signing in is still required to redeem, because a code grants access to a
    // real board and membership has to attach to an account. It is just no
    // longer required to SEE the box: someone read out a code and told to go
    // and type it should land on the thing they were told to type it into, not
    // on a signup form. The code rides along in `next` so it survives the trip
    // and they never type it twice.
    if (!signedIn) {
      navigate(`/login?next=${encodeURIComponent(joinPath(code))}`)
      return
    }

    await redeem(code)
  }

  return (
    <AuthShell
      title="Join a board"
      subtitle="Enter the six-letter code from whoever is running the session."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">Code</span>
          <input
            autoFocus
            value={code}
            onChange={(e) => {
              setCode(clean(e.target.value))
              setError(null)
            }}
            placeholder="ABCDEF"
            aria-label="Join code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="w-full rounded border border-rule bg-sunken px-3 py-3 text-center font-mono
              text-[28px] uppercase tracking-[0.3em] text-ink placeholder:text-ink-3/40
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
        </label>

        {error && (
          <p role="alert" className="text-[12px] leading-relaxed text-accent">
            {error}
          </p>
        )}

        {!signedIn && (
          <p className="text-[12px] leading-relaxed text-ink-2">
            You will be asked to sign in before you join. Your code is kept, so you will not
            need to type it again.
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          disabled={code.length !== CODE_LENGTH || busy}
          className="w-full"
        >
          {busy ? 'Joining…' : 'Join'}
        </Button>

        <p className="text-center text-[12px] text-ink-3">
          Got a link instead? Just open it.{' '}
          <Link to="/board" className="text-accent transition-colors hover:text-accent-hover">
            Back to your boards
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}
