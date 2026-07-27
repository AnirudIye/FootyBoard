import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { BoardMember } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useRealtimeStore } from '../../store/realtimeStore'
import { toast } from '../../store/toastStore'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { Toggle } from '../ui/Toggle'

/**
 * Sharing a board, and taking the floor.
 *
 * Only the owner sees any of this. A member has nothing to manage — they were
 * let in, and the one thing that concerns them (whether they may edit) shows in
 * the HUD instead.
 *
 * The link is only ever readable at the moment it is created. The server stores
 * a hash, so there is no "show me the link again" to build; regenerating is the
 * honest alternative, and it revokes the previous one.
 */
/**
 * How long the code has left, in the terms someone about to read it out cares
 * about. Rounded down, so "1h" never means "in fifty seconds".
 */
function expiryLabel(expiresAt: number | null): string {
  if (expiresAt === null) return ''
  const left = expiresAt - Date.now()
  if (left <= 0) return 'Expired'

  const minutes = Math.floor(left / 60_000)
  if (minutes < 60) return `Expires in ${Math.max(1, minutes)}m`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `Expires in ${hours}h` : `Expires in ${hours}h ${rest}m`
}

export default function ShareDialog() {
  const email = useAuthStore((s) => s.email)
  const currentId = useBoardsStore((s) => s.currentId)
  const boards = useBoardsStore((s) => s.boards)
  const role = useRealtimeStore((s) => s.role)

  const [open, setOpen] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [codeExpiresAt, setCodeExpiresAt] = useState<number | null>(null)
  const [members, setMembers] = useState<BoardMember[]>([])
  const [busy, setBusy] = useState(false)

  // Re-renders on a minute's tick so "expires in 3h 20m" does not sit there
  // going stale while the panel is open.
  const [, setNow] = useState(Date.now())
  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [open])

  /**
   * Read, never copied.
   *
   * This used to be local state seeded from `boards[].membersCanEdit`, which is
   * a mirror nothing updates when the lock changes — so after one toggle the
   * dialog showed the state as of page load rather than the truth, and told the
   * owner the board was unlocked while the server had it locked. The socket
   * already carries the authoritative value and the server already broadcasts
   * every change, so the honest thing is to render that directly.
   */
  const locked = useRealtimeStore((s) => s.boardLocked)

  const expired = codeExpiresAt !== null && codeExpiresAt <= Date.now()

  const board = boards.find((b) => b.id === currentId)
  // Fall back to the board list when the socket has not landed yet, so the
  // control does not flicker in on connect.
  const isOwner = role ? role === 'owner' : (board?.role ?? 'owner') === 'owner'

  useEffect(() => {
    if (!open || !currentId) return
    setBusy(true)
    void (async () => {
      try {
        const [share, list] = await Promise.all([
          api.getShare(currentId),
          api.listMembers(currentId),
        ])
        // The code comes back every time; the link does not exist to be read.
        setCode(share.share?.code ?? null)
        setCodeExpiresAt(share.share?.codeExpiresAt ?? null)
        setMembers(list.members)
      } catch (err) {
        toast(toUserMessage(err, 'Could not load the sharing settings.'))
      } finally {
        setBusy(false)
      }
    })()
    setLink(null)
  }, [open, currentId])

  if (!email || !currentId || !isOwner) return null

  const shareUrl = (token: string) =>
    `${window.location.origin}/board?board=${currentId}&share=${encodeURIComponent(token)}`

  const createShare = async () => {
    setBusy(true)
    try {
      const { share } = await api.createShare(currentId)
      setLink(shareUrl(share.token))
      const replaced = code !== null
      setCode(share.code)
      setCodeExpiresAt(share.codeExpiresAt)
      toast(replaced ? 'New code and link ready. The old ones no longer work.' : 'Sharing is on.')
    } catch (err) {
      toast(toUserMessage(err, 'Could not turn on sharing.'))
    } finally {
      setBusy(false)
    }
  }

  const refreshCode = async () => {
    setBusy(true)
    try {
      const { share } = await api.refreshCode(currentId)
      setCode(share.code)
      setCodeExpiresAt(share.codeExpiresAt)
      toast('New code ready. The link still works.')
    } catch (err) {
      toast(toUserMessage(err, 'Could not get a new code.'))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast(`${what} copied.`)
    } catch {
      // Clipboard access can be refused; the field is selectable either way.
      toast(`Could not copy automatically. Select the ${what.toLowerCase()} and copy it.`)
    }
  }

  const revoke = async () => {
    setBusy(true)
    try {
      await api.revokeShare(currentId)
      setCode(null)
      setCodeExpiresAt(null)
      setLink(null)
      toast('Sharing off. People already on the board still have access.')
    } catch (err) {
      toast(toUserMessage(err, 'Could not turn off sharing.'))
    } finally {
      setBusy(false)
    }
  }

  const setLock = async (next: boolean) => {
    // Applied locally first so the switch responds immediately, then confirmed
    // by the server's own broadcast, which is what every other client acts on.
    useRealtimeStore.getState().setLocked(next)
    useBoardsStore.getState().setMembersCanEdit(currentId, !next)
    try {
      await api.setBoardLock(currentId, next)
    } catch (err) {
      useRealtimeStore.getState().setLocked(!next)
      useBoardsStore.getState().setMembersCanEdit(currentId, next)
      toast(toUserMessage(err, 'Could not change who can edit.'))
    }
  }

  const removeMember = async (member: BoardMember) => {
    if (!window.confirm(`Remove ${member.email} from this board?`)) return
    try {
      await api.removeMember(currentId, member.id)
      setMembers((m) => m.filter((x) => x.id !== member.id))
      toast(`${member.email} was removed.`)
    } catch (err) {
      toast(toUserMessage(err, 'Could not remove them.'))
    }
  }

  return (
    <Popover
      align="right"
      className="w-[300px]"
      open={open}
      onOpenChange={setOpen}
      trigger={<Button variant="secondary">Share</Button>}
    >
      <div className="flex flex-col gap-3.5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">Join code</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
            Read this out, or send the link. Either way they sign in and land here.
          </p>
        </div>

        {code ? (
          <>
            {/* The code is the headline: it exists to be read off a screen from
                the back of a room, so it gets the size to match. */}
            <div className="flex flex-col items-center gap-2 rounded border border-rule bg-sunken py-3">
              <span
                className={`font-mono text-[30px] leading-none tracking-[0.22em] ${
                  expired ? 'text-ink-3 line-through' : 'text-ink'
                }`}
              >
                {code}
              </span>
              <span
                className={`font-mono text-[10px] uppercase tracking-[0.1em] ${
                  expired ? 'text-accent' : 'text-ink-3'
                }`}
              >
                {expiryLabel(codeExpiresAt)}
              </span>
              {!expired && (
                <button
                  onClick={() => copy(code, 'Code')}
                  className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3
                    transition-colors hover:text-accent"
                >
                  Copy code
                </button>
              )}
            </div>

            {link ? (
              <div className="flex flex-col gap-2">
                <input
                  readOnly
                  value={link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full rounded border border-rule bg-sunken px-2 py-1.5 font-mono text-[11px] text-ink
                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                />
                <Button onClick={() => copy(link, 'Link')}>Copy link</Button>
                <p className="text-[11px] leading-relaxed text-ink-3">
                  Copy the link now. It is stored hashed, so it cannot be shown again. The
                  code above can.
                </p>
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-ink-3">
                The link was only shown when it was created. Generate a new pair below if you
                need it. The current code will stop working.
              </p>
            )}
          </>
        ) : (
          <Button onClick={createShare} disabled={busy} className="w-full">
            Turn on sharing
          </Button>
        )}

        {code && (
          <div className="flex flex-col gap-2.5">
            {/* Refreshing the code is the routine action — start of a session,
                or the last one aged out — so it is the button, and it is safe:
                it does not touch the link anyone already has. */}
            <Button onClick={refreshCode} disabled={busy} variant={expired ? 'primary' : 'secondary'}>
              New code
            </Button>
            <div className="flex gap-4">
              <button
                onClick={createShare}
                disabled={busy}
                className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3
                  transition-colors hover:text-accent disabled:opacity-50"
                title="Issues a new code and a new link. Any link already sent out stops working."
              >
                New link too
              </button>
              <button
                onClick={revoke}
                disabled={busy}
                className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3
                  transition-colors hover:text-accent disabled:opacity-50"
              >
                Stop sharing
              </button>
            </div>
          </div>
        )}

        <div className="border-t border-rule pt-3">
          <Toggle checked={locked} onChange={setLock} label="Lock editing" />
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            {locked
              ? 'Only you can move things. Everyone else is watching.'
              : 'Everyone on this board can move things.'}
          </p>
        </div>

        <div className="border-t border-rule pt-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
            On this board
          </p>
          {members.length === 0 ? (
            <p className="mt-1.5 text-[11px] text-ink-3">Nobody else yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2" title={m.email}>
                    {m.email}
                  </span>
                  <button
                    onClick={() => removeMember(m)}
                    className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3
                      transition-colors hover:text-accent"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Popover>
  )
}
