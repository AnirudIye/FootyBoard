import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { BoardMember, ShareMeta } from '../../lib/api'
import { AppError, toUserMessage } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useRealtimeStore } from '../../store/realtimeStore'
import { toast } from '../../store/toastStore'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { Toggle } from '../ui/Toggle'
import { relativeTime } from './relativeTime'

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
/** How long the code has left, in the terms someone about to read it out cares
 *  about. */
function expiryLabel(expiresAt: number | null): string {
  if (expiresAt === null) return ''
  const left = expiresAt - Date.now()
  return left <= 0 ? 'Expired' : `Expires ${relativeTime(left)}`
}

// A removed member can be let back in with the code, so the safe order is to
// act and offer it back rather than to ask first. The write is held for as long
// as the toast is up, which is the only window in which Undo can mean anything.
const UNDO_WINDOW = 4000

/**
 * The two calls that carry anonymous presence, written here rather than in
 * `lib/api.ts`.
 *
 * They belong beside the rest of the wrapper and should move there. They are
 * local for now only because this change did not own that file, and a feature
 * that half exists is worse than one seam with a note on it. Behaviour matches
 * `request`: the session cookie goes along, and an error the server explained
 * is re-thrown with its own message so the toast can say something useful.
 */
type ShareState = { share: ShareMeta | null; anonymousPresence?: boolean }

async function setAnonymousPresence(boardId: string, anonymous: boolean): Promise<void> {
  const response = await fetch(`/api/boards/${boardId}/anonymous`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anonymous }),
  }).catch(() => {
    throw new AppError("Can't reach the server. Check your connection and try again.")
  })
  if (response.ok) return

  const payload = await response.json().catch(() => null)
  throw new AppError(
    payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : 'That did not work. Try again.',
  )
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
  const [anonymous, setAnonymous] = useState(false)
  const [busy, setBusy] = useState(false)

  // Re-renders on a minute's tick so "expires in 3h 20m" does not sit there
  // going stale while the panel is open.
  const [, setNow] = useState(Date.now())
  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [open])

  const expired = codeExpiresAt !== null && codeExpiresAt <= Date.now()

  const board = boards.find((b) => b.id === currentId)
  // Fall back to the board list when the socket has not landed yet, so the
  // control does not flicker in on connect.
  const isOwner = role ? role === 'owner' : (board?.role ?? 'owner') === 'owner'

  /**
   * Read, never copied.
   *
   * This used to be local state seeded from `boards[].membersCanEdit`, which is
   * a mirror nothing updates when the lock changes — so after one toggle the
   * dialog showed the state as of page load rather than the truth, and told the
   * owner the board was unlocked while the server had it locked.
   *
   * The socket is authoritative once it has said `welcome`, which `peerId` is
   * the signal for. Before that it has said nothing, and `boardLocked` is only
   * its own default — reading it regardless told the same lie in the other
   * direction, showing a locked board as unlocked on every reload and for as
   * long as the socket was down. The list's REST value is the only truth
   * available in that window. Still read on every render, never copied into
   * state, which is the part that mattered.
   */
  const socketLocked = useRealtimeStore((s) => s.boardLocked)
  const peerId = useRealtimeStore((s) => s.peerId)
  const locked = peerId ? socketLocked : board?.membersCanEdit === false

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
        // Anonymity is a property of the board, so it comes back beside the
        // share rather than inside it: it stands whether or not a link is live.
        setAnonymous((share as ShareState).anonymousPresence === true)
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

  /**
   * Instructor mode.
   *
   * The same board flag the editing lock always was, renamed to what it is
   * actually for: one person demonstrating while the room watches. Only the
   * wording changed here — the endpoint, the relay's enforcement and what a
   * guest experiences are all exactly as before.
   */
  const setInstructorMode = async (next: boolean) => {
    // Applied locally first so the switch responds immediately, then confirmed
    // by the server's own broadcast, which is what every other client acts on.
    useRealtimeStore.getState().setLocked(next)
    useBoardsStore.getState().setMembersCanEdit(currentId, !next)
    try {
      await api.setBoardLock(currentId, next)
    } catch (err) {
      useRealtimeStore.getState().setLocked(!next)
      useBoardsStore.getState().setMembersCanEdit(currentId, next)
      toast(toUserMessage(err, 'Could not switch instructor mode.'))
    }
  }

  const setAnonymity = async (next: boolean) => {
    // Optimistic for the same reason the lock is: the switch has to answer the
    // press. Unlike the lock there is no broadcast to confirm it, because no
    // client is trusted with this one — the substitution happens in the relay's
    // own payloads, so the only thing to put right on failure is this switch.
    setAnonymous(next)
    try {
      await setAnonymousPresence(currentId, next)
    } catch (err) {
      setAnonymous(!next)
      toast(toUserMessage(err, 'Could not change how guests are named.'))
    }
  }

  const removeMember = (member: BoardMember) => {
    const restore = () =>
      setMembers((m) => (m.some((x) => x.id === member.id) ? m : [...m, member]))

    // The row goes at once and the request follows once Undo has had its
    // chance, which is the only way an undo can be honest: there is no endpoint
    // that puts a member back, only the code they came in with.
    setMembers((m) => m.filter((x) => x.id !== member.id))
    const pending = window.setTimeout(() => {
      void api.removeMember(currentId, member.id).catch((err) => {
        restore()
        toast(toUserMessage(err, 'Could not remove them.'))
      })
    }, UNDO_WINDOW)

    toast(`${member.email} was removed.`, {
      label: 'Undo',
      run: () => {
        window.clearTimeout(pending)
        restore()
      },
    })
  }

  return (
    <Popover
      align="right"
      className="w-[300px]"
      open={open}
      onOpenChange={setOpen}
      trigger="Share"
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

        {/* Both switches are the owner's alone, which the dialog already
            enforces by not existing for anybody else — the same way every other
            row here is owner-only. The label says so anyway, because a control
            that changes what the whole room can do should read as a control
            over the room rather than as a personal preference.

            It is also on `--ink-2` while the rest of the dialog's micro-copy is
            on `--ink-3`. Not for contrast: `--ink-3` was lifted to 124 134 127
            and now measures 4.92:1 on `--surface`, so it clears the floor on
            its own. This is the one part of the dialog whose copy states a
            consequence for other people rather than naming a section: who may
            move things, and who can see whose address. Both are worth reading
            before the switch is thrown, so they get the brighter ink. */}
        <div className="flex flex-col gap-3 border-t border-rule pt-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-2">
            Owner only
          </p>

          <div>
            <Toggle checked={locked} onChange={setInstructorMode} label="Instructor mode" />
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-2">
              {locked
                ? 'Only you can move things. Everyone else is watching.'
                : 'Everyone on this board can move things.'}
            </p>
          </div>

          <div>
            <Toggle checked={anonymous} onChange={setAnonymity} label="Anonymous guests" />
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-2">
              {anonymous
                ? 'Cursors show a made-up name like Anonymous Quokka. Nobody in the room sees anyone else’s email, including you. You still see real addresses in the list below.'
                : 'Cursors and the presence stack show everyone’s email address, to everyone on the board.'}
            </p>
          </div>
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
