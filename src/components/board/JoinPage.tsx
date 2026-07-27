import { useEffect, useState } from 'react'
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
  const ready = useAuthStore((s) => s.ready)
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const [code, setCode] = useState(() => clean(params.get('code') ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A code in the URL is a convenience, not a credential — it still has to be
  // redeemed, and the person still has to be signed in.
  useEffect(() => {
    if (ready && !email) {
      const next = encodeURIComponent(`/join${code ? `?code=${code}` : ''}`)
      navigate(`/login?next=${next}`, { replace: true })
    }
  }, [ready, email, code, navigate])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (code.length !== CODE_LENGTH || busy) return

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
