import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'
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

const CODE_LENGTH = 6
/** Matches the server's alphabet — no I or O, no digits. */
const clean = (raw: string) =>
  raw.toUpperCase().replace(/[^A-HJ-NP-Z]/g, '').slice(0, CODE_LENGTH)

export default function JoinPage() {
  const email = useAuthStore((s) => s.email)
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const [code, setCode] = useState(() => clean(params.get('code') ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (code.length !== CODE_LENGTH || busy) return

    // Signing in is still required to redeem, because a code grants access to a
    // real board and membership has to attach to an account. It is just no
    // longer required to SEE the box: someone read out a code and told to go
    // and type it should land on the thing they were told to type it into, not
    // on a signup form. The code rides along in `next` so it survives the trip
    // and they never type it twice.
    if (!email) {
      navigate(`/login?next=${encodeURIComponent(`/join?code=${code}`)}`)
      return
    }

    setBusy(true)
    setError(null)
    try {
      const { board } = await api.joinWithCode(code)
      // The board was not ours a moment ago, so the picker has not heard of it.
      await useBoardsStore.getState().load()
      useBoardsStore.getState().select(board.id)
      navigate('/board', { replace: true })
    } catch (err) {
      setError(toUserMessage(err, 'That code is not valid. Check it and try again.'))
      setBusy(false)
    }
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

        {!email && (
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
