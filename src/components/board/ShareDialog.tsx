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
export default function ShareDialog() {
  const email = useAuthStore((s) => s.email)
  const currentId = useBoardsStore((s) => s.currentId)
  const boards = useBoardsStore((s) => s.boards)
  const role = useRealtimeStore((s) => s.role)

  const [open, setOpen] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [hasShare, setHasShare] = useState(false)
  const [members, setMembers] = useState<BoardMember[]>([])
  const [locked, setLocked] = useState(false)
  const [busy, setBusy] = useState(false)

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
        setHasShare(share.share !== null)
        setMembers(list.members)
        setLocked(board?.membersCanEdit === false)
      } catch (err) {
        toast(toUserMessage(err, 'Could not load the sharing settings.'))
      } finally {
        setBusy(false)
      }
    })()
    // The link itself is never re-read — it does not exist to be read.
    setLink(null)
  }, [open, currentId, board?.membersCanEdit])

  if (!email || !currentId || !isOwner) return null

  const shareUrl = (token: string) =>
    `${window.location.origin}/board?board=${currentId}&share=${encodeURIComponent(token)}`

  const createLink = async () => {
    setBusy(true)
    try {
      const { share } = await api.createShare(currentId)
      setLink(shareUrl(share.token))
      setHasShare(true)
      toast(hasShare ? 'New link ready. The previous one no longer works.' : 'Share link ready.')
    } catch (err) {
      toast(toUserMessage(err, 'Could not create a share link.'))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      toast('Link copied.')
    } catch {
      // Clipboard access can be refused; the field is selectable either way.
      toast('Could not copy automatically — select the link and copy it.')
    }
  }

  const revoke = async () => {
    setBusy(true)
    try {
      await api.revokeShare(currentId)
      setHasShare(false)
      setLink(null)
      toast('Link revoked. People already on the board still have access.')
    } catch (err) {
      toast(toUserMessage(err, 'Could not revoke the link.'))
    } finally {
      setBusy(false)
    }
  }

  const setLock = async (next: boolean) => {
    setLocked(next)
    try {
      await api.setBoardLock(currentId, next)
    } catch (err) {
      setLocked(!next)
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
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">Share link</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
            Anyone signed in who opens this link joins the board.
          </p>
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
            <div className="flex gap-2">
              <Button onClick={copy} className="flex-1">
                Copy link
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-3">
              Copy it now — it is stored hashed, so it cannot be shown again.
            </p>
          </div>
        ) : (
          <Button onClick={createLink} disabled={busy} className="w-full">
            {hasShare ? 'Generate a new link' : 'Create a share link'}
          </Button>
        )}

        {hasShare && (
          <button
            onClick={revoke}
            disabled={busy}
            className="self-start font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3
              transition-colors hover:text-accent disabled:opacity-50"
          >
            Revoke link
          </button>
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
