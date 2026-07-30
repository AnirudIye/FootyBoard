import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { BoardMember } from '../../lib/api'
import { toUserMessage } from '../../lib/errors'
import { useAuthStore, selectSignedIn } from '../../store/authStore'
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
 * The server stores only a hash of the link, so `POST /share` is the one and
 * only time its plaintext exists outside the browser that asked for it. That
 * makes every value here a copy of something the server owns, and the link, the
 * lock and anonymity all follow the same rule: show what the server last said,
 * and let the server retire it. Nothing is seeded from a mirror that no reply
 * updates, and nothing is kept once the server stops vouching for it.
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

// Long enough to read the question and mean the second press, short enough that
// a button left armed is not still armed the next time anyone looks at it.
const ROTATE_CONFIRM_WINDOW = 6000

/**
 * What the server last said about one board's share.
 *
 * One value rather than three loose fields, and it carries the board it was
 * read for. The panel outlives the board: it is mounted for the life of the
 * toolbar, so without the board id here, opening it on a second board shows the
 * first board's code, and the first board's link, until the read comes back.
 * Anything that does not name the open board is not shown at all.
 */
interface ShareFacts {
  boardId: string
  /** Null when sharing is off. Changes when the share is rotated. */
  shareId: string | null
  code: string | null
  codeExpiresAt: number | null
}

export default function ShareDialog() {
  const signedIn = useAuthStore(selectSignedIn)
  const currentId = useBoardsStore((s) => s.currentId)
  const boards = useBoardsStore((s) => s.boards)
  const role = useRealtimeStore((s) => s.role)

  const [open, setOpen] = useState(false)
  const [facts, setFacts] = useState<ShareFacts | null>(null)
  const [link, setLink] = useState<{ shareId: string; url: string } | null>(null)
  const [members, setMembers] = useState<BoardMember[]>([])
  const [anonymous, setAnonymous] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)

  // Re-renders on a minute's tick so "expires in 3h 20m" does not sit there
  // going stale while the panel is open.
  const [, setNow] = useState(Date.now())
  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [open])

  // Nothing read for another board is shown against this one.
  const live = facts && facts.boardId === currentId ? facts : null
  const code = live?.code ?? null
  const codeExpiresAt = live?.codeExpiresAt ?? null

  /**
   * The link, for exactly as long as it is still the live one.
   *
   * The plaintext token exists in one place outside the server, and this is it,
   * from the moment `POST /share` answers. It used to be thrown away every time
   * the panel was reopened — an ordinary thing to do, since reading the code out
   * and then coming back for the link is the flow the panel is laid out for —
   * and the only route back to a working link was rotating, which revokes the
   * one somebody may already be holding. So it is kept, and the server decides
   * when it stops counting rather than the panel guessing: `shareId` is re-read
   * on every open, so a share revoked or rotated in another tab retires this
   * copy without anything having to tell it. A reload still loses it, which is
   * correct and is what the copy below says.
   */
  const linkUrl = link && live && link.shareId === live.shareId ? link.url : null

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
        // The code comes back every time; the token does not exist to be read.
        // `id` does, and it is what says whether the link held above is still
        // the live one.
        setFacts({
          boardId: currentId,
          shareId: share.share?.id ?? null,
          code: share.share?.code ?? null,
          codeExpiresAt: share.share?.codeExpiresAt ?? null,
        })
        // Anonymity is a property of the board, so it comes back beside the
        // share rather than inside it: it stands whether or not a link is live.
        setAnonymous(share.anonymousPresence)
        setMembers(list.members)
      } catch (err) {
        toast(toUserMessage(err, 'Could not load the sharing settings.'))
      } finally {
        setBusy(false)
      }
    })()
  }, [open, currentId])

  // An armed "are you sure" forgets itself, so a rotation cannot be one stray
  // press away minutes later or the next time the panel is opened.
  useEffect(() => {
    if (!confirmRotate) return
    if (!open) return setConfirmRotate(false)
    const t = window.setTimeout(() => setConfirmRotate(false), ROTATE_CONFIRM_WINDOW)
    return () => window.clearTimeout(t)
  }, [confirmRotate, open])

  if (!signedIn || !currentId || !isOwner) return null

  const shareUrl = (token: string) =>
    `${window.location.origin}/board?board=${currentId}&share=${encodeURIComponent(token)}`

  /**
   * Create or rotate the link.
   *
   * The reply is the only time the token is ever legible, so both halves of it
   * are put into state together and nothing between here and the render is
   * allowed to drop either. `share.id` goes with the link rather than being
   * discarded, because it is what later reads compare against to decide whether
   * this copy is still the live one.
   */
  const createShare = async () => {
    setBusy(true)
    try {
      const { share } = await api.createShare(currentId)
      setLink({ shareId: share.id, url: shareUrl(share.token) })
      const replaced = code !== null
      setFacts({
        boardId: currentId,
        shareId: share.id,
        code: share.code,
        codeExpiresAt: share.codeExpiresAt,
      })
      toast(replaced ? 'New code and link ready. The old ones no longer work.' : 'Sharing is on.')
    } catch (err) {
      toast(toUserMessage(err, 'Could not turn on sharing.'))
    } finally {
      setConfirmRotate(false)
      setBusy(false)
    }
  }

  const refreshCode = async () => {
    setBusy(true)
    try {
      const { share } = await api.refreshCode(currentId)
      // Same share, new code, so the link held above is untouched: that is the
      // whole reason this is a separate endpoint from rotating.
      setFacts({
        boardId: currentId,
        shareId: share.id,
        code: share.code,
        codeExpiresAt: share.codeExpiresAt,
      })
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
      setFacts({ boardId: currentId, shareId: null, code: null, codeExpiresAt: null })
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
    // Applied optimistically so the switch answers the press, then settled on
    // what the reply says the board is rather than on what was asked for. Both
    // go into the stores the switch reads through, never into a copy beside
    // them: `boardLocked` for a connected client and the board list's
    // `membersCanEdit` for one that is not.
    useRealtimeStore.getState().setLocked(next)
    useBoardsStore.getState().setMembersCanEdit(currentId, !next)
    try {
      const { locked } = await api.setBoardLock(currentId, next)
      useRealtimeStore.getState().setLocked(locked)
      useBoardsStore.getState().setMembersCanEdit(currentId, !locked)
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
    // own payloads. So the reply is the only confirmation there is, and it is
    // what the switch settles on; assuming the write landed the way it was
    // asked for is the same latching this panel is not allowed to do.
    setAnonymous(next)
    try {
      const { anonymousPresence } = await api.setAnonymousPresence(currentId, next)
      setAnonymous(anonymousPresence)
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

    // `displayName` rather than `email`, which is null for a guest: this toast
    // used to read "null was removed" for exactly the people the owner is most
    // likely to be removing.
    toast(`${member.displayName} was removed.`, {
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

            {linkUrl ? (
              <div className="flex flex-col gap-2">
                <input
                  readOnly
                  value={linkUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full rounded border border-rule bg-sunken px-2 py-1.5 font-mono text-[11px] text-ink
                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                />
                <Button onClick={() => copy(linkUrl, 'Link')}>Copy link</Button>
                <p className="text-[11px] leading-relaxed text-ink-3">
                  Copy the link before you reload. The server keeps only a hash of it, so this
                  tab is the last place it exists. The code above can always be read again.
                </p>
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-ink-3">
                The link was only shown when it was created, and this tab no longer has it.
                Issuing a new one below is the way back, and it stops the old link working for
                anyone still holding it.
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
            {/* The one control here that takes something away from people who
                are not in the room: whoever is holding the current link loses
                it, and there is no list of who that is. So it asks first, in
                the button itself rather than behind a dialog, and the question
                expires on its own. Turning sharing on for the first time is the
                same call and is not gated, because there is nothing to break. */}
            <div className="flex gap-4">
              <button
                onClick={() => (confirmRotate ? void createShare() : setConfirmRotate(true))}
                disabled={busy}
                className={`font-mono text-[10px] uppercase tracking-[0.1em] transition-colors
                  disabled:opacity-50 ${confirmRotate ? 'text-accent' : 'text-ink-3 hover:text-accent'}`}
                title="Issues a new code and a new link. Any link already sent out stops working."
              >
                {confirmRotate ? 'Yes, break the old link' : 'New link too'}
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
                : 'Cursors and the presence stack show the name each person chose for themselves. Anyone who has not chosen one is shown by their email address instead.'}
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
                  {/* `displayName` is the only field to draw, the same rule the
                      room's peers follow. It is the address for anybody who has
                      one, because who has access to this board is the owner's to
                      know; a guest has none, and drawing `email` put a blank row
                      with a Remove button beside it. */}
                  <span
                    className="min-w-0 flex-1 truncate text-[12px] text-ink-2"
                    title={m.displayName}
                  >
                    {m.displayName}
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
