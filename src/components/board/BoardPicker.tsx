import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useBoardsStore } from '../../store/boardsStore'
import { useBoardStore, defaultPersistedBoard } from '../../store/boardStore'
import { useAuthStore, selectSignedIn } from '../../store/authStore'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { toast } from '../../store/toastStore'
import { toUserMessage } from '../../lib/errors'
import { relativeTime } from './relativeTime'

export default function BoardPicker() {
  const signedIn = useAuthStore(selectSignedIn)
  const boards = useBoardsStore((s) => s.boards)
  const currentId = useBoardsStore((s) => s.currentId)
  const nextCursor = useBoardsStore((s) => s.nextCursor)
  const select = useBoardsStore((s) => s.select)
  const create = useBoardsStore((s) => s.create)
  const rename = useBoardsStore((s) => s.rename)
  const remove = useBoardsStore((s) => s.remove)
  const loadMore = useBoardsStore((s) => s.loadMore)

  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [busy, setBusy] = useState(false)

  // Saving is an account feature, so the picker is too.
  if (!signedIn) return null

  const current = boards.find((b) => b.id === currentId)

  const guard = async (run: () => Promise<void>, fallback: string) => {
    setBusy(true)
    try {
      await run()
    } catch (err) {
      toast(toUserMessage(err, fallback))
    } finally {
      setBusy(false)
    }
  }

  const onCreate = () =>
    guard(async () => {
      // A new board starts from the default setup, not a copy of the open one.
      //
      // Built, sent, and only then shown. Resetting the store first looked
      // equivalent and was not: the reset fires the autosave subscription,
      // which schedules a write against the board still open, and nothing
      // cancels that timer because cancellation hangs off the current board
      // changing, which only happens once the create succeeds. So a create that
      // failed, or merely took longer than the debounce, left a `PUT` of a
      // blank default board landing on the row holding the coach's actual work.
      // The open board is not touched until there is a new one to move to.
      const snapshot = defaultPersistedBoard()
      const newId = await create(`Board ${boards.length + 1}`, snapshot)
      useBoardStore.getState().initDefaultBoard(newId)
      toast('New board started.')
    }, 'The board could not be created.')

  const commitRename = (id: string) =>
    guard(async () => {
      const name = draftName.trim()
      setRenaming(null)
      if (!name) return
      await rename(id, name)
    }, 'The board could not be renamed.')

  const onDelete = (id: string, name: string) =>
    guard(async () => {
      if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return
      await remove(id)
      toast('Board deleted.')
    }, 'The board could not be deleted.')

  return (
    <Popover
      align="left"
      className="w-[300px]"
      triggerClassName="max-w-[190px] gap-2"
      trigger={
        <>
          <span className="truncate">{current?.name ?? 'Boards'}</span>
          <span aria-hidden className="text-ink-3">
            ▾
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
            Your boards
          </span>
          <Button variant="primary" className="px-2 py-1 text-[11px]" onClick={onCreate} disabled={busy}>
            + New
          </Button>
        </div>

        <ul className="-mx-1 max-h-[280px] overflow-y-auto">
          {boards.map((board) => {
            const active = board.id === currentId
            return (
              <li key={board.id} className="group">
                {renaming === board.id ? (
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={() => commitRename(board.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(board.id)
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    className="mx-1 w-[calc(100%-0.5rem)] rounded border border-accent bg-sunken px-2 py-1.5
                      text-[13px] text-ink focus-visible:outline-none"
                  />
                ) : (
                  <div
                    className={`flex items-center gap-1 rounded px-1 transition-colors ${
                      active ? 'bg-[var(--accent-wash)]' : 'hover:bg-sunken'
                    }`}
                  >
                    <button
                      onClick={() => select(board.id)}
                      className="flex min-w-0 flex-1 flex-col items-start px-1.5 py-1.5 text-left"
                    >
                      <span
                        className={`w-full truncate text-[13px] ${active ? 'text-accent' : 'text-ink'}`}
                      >
                        {board.name}
                      </span>
                      <span className="font-mono text-[10px] text-ink-3">
                        {relativeTime(Date.parse(board.updatedAt) - Date.now())}
                      </span>
                    </button>

                    <button
                      onClick={() => {
                        setRenaming(board.id)
                        setDraftName(board.name)
                      }}
                      title="Rename"
                      aria-label={`Rename ${board.name}`}
                      className="rounded px-1.5 py-1 text-[11px] text-ink-3 opacity-0 transition-opacity
                        hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => onDelete(board.id, board.name)}
                      title="Delete"
                      aria-label={`Delete ${board.name}`}
                      disabled={boards.length === 1}
                      className="rounded px-1.5 py-1 text-[11px] text-ink-3 opacity-0 transition-opacity
                        hover:text-accent focus-visible:opacity-100 group-hover:opacity-100
                        disabled:cursor-not-allowed disabled:opacity-0"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        {nextCursor && (
          <Button
            variant="quiet"
            className="w-full text-[12px]"
            onClick={() => guard(loadMore, 'More boards could not be loaded.')}
            disabled={busy}
          >
            Load more
          </Button>
        )}

        {boards.length === 0 && (
          <span className="px-1 py-2 text-[12px] text-ink-3">No boards yet.</span>
        )}

        {/* Someone who has been read a code rather than sent a link has to be
            able to find their way in from inside the app, not only from a URL
            they were told to type.

            `flex items-center` and pointedly not `inline-flex justify-center`,
            unlike the other button-shaped links in this fix. This one is a
            stretched item of a `flex-col`, so its box is the popover's full
            width and the `border-t` above it is a rule across the whole panel:
            shrink-wrapping it would pull that rule in to the width of the
            words, and centring the label would move text that has always been
            left-aligned. Only the vertical was wrong.

            `touch:pt-0` is the other half, and without it this element is the
            one place where `items-center` makes things worse rather than
            better. `align-items` centres within the *content* box, and the 1px
            rule plus 10px of `pt-2.5` sit outside it, so under the 44px floor
            the label gets centred in the space below the rule and ends up low
            in the box instead of high: measured 11 above / 19 below untouched,
            20 / 10 with `items-center` alone, 15 / 15 with this. The padding
            exists to keep the rule off the text, and under the floor there are
            18px of slack doing that job already, so giving it up under a finger
            costs nothing. This is exactly the case `touch:` is for — the floor
            being the wrong shape and the component saying so — and it is size,
            which is all that variant is allowed to change. Both are inert on a
            mouse, where the box is 26px and there is no slack to distribute. */}
        <Link
          to="/join"
          className="flex items-center border-t border-rule pt-2.5 touch:pt-0 font-mono text-[10px]
            uppercase tracking-[0.1em] text-ink-3 transition-colors hover:text-accent"
        >
          Join with a code
        </Link>
      </div>
    </Popover>
  )
}
