import { useState } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useBoardStore } from '../../store/boardStore'
import { useAuthStore } from '../../store/authStore'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { toast } from '../../store/toastStore'
import { toUserMessage } from '../../lib/errors'

/** "3 minutes ago" reads better than a timestamp for something you just touched. */
function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function BoardPicker() {
  const signedIn = useAuthStore((s) => s.email)
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
      useBoardStore.getState().initDefaultBoard()
      const snapshot = useBoardStore.getState().getPersistable()
      await create(`Board ${boards.length + 1}`, snapshot)
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
      trigger={
        <Button variant="secondary" className="max-w-[190px] gap-2">
          <span className="truncate">{current?.name ?? 'Boards'}</span>
          <span aria-hidden className="text-ink-3">
            ▾
          </span>
        </Button>
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
                      <span className="font-mono text-[10px] text-ink-3">{ago(board.updatedAt)}</span>
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
      </div>
    </Popover>
  )
}
