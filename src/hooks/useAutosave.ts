import { useEffect, useRef } from 'react'
import { useBoardStore } from '../store/boardStore'
import { useAuthStore } from '../store/authStore'
import { useBoardsStore } from '../store/boardsStore'
import { api } from '../lib/api'
import { loadBoard } from '../lib/boardSync'
import { isApplyingRemote } from '../lib/realtime/bridge'
import { toUserMessage } from '../lib/errors'
import { toast } from '../store/toastStore'

const DEBOUNCE = 800

/**
 * Keeps the open board in step with the server.
 *
 * Two effects, deliberately separate: one owns which board is open, the other
 * owns saving it. Combining them would make every keystroke re-run the load.
 */
export function useAutosave() {
  const email = useAuthStore((s) => s.email)
  const ready = useAuthStore((s) => s.ready)
  const currentId = useBoardsStore((s) => s.currentId)

  // Guards the save subscription against writing a board that is still loading.
  const loadedId = useRef<string | null>(null)

  // 1. Signing in loads the board list; signing out clears it.
  useEffect(() => {
    if (!ready) return
    const boards = useBoardsStore.getState()

    if (!email) {
      // Guest: a full board that is never written anywhere.
      loadedId.current = null
      boards.reset()
      useBoardStore.getState().initDefaultBoard()
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const id = await boards.load()
        if (cancelled || id) return
        // A brand new account has nothing yet, so give it something to open.
        useBoardStore.getState().initDefaultBoard()
        await boards.create('My board', useBoardStore.getState().getPersistable())
      } catch (err) {
        if (!cancelled) toast(toUserMessage(err, 'Your boards could not be loaded.'))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [email, ready])

  // 2. Opening a board — at sign-in or from the picker — pulls its contents.
  useEffect(() => {
    if (!email || !currentId) return

    let cancelled = false
    loadedId.current = null

    void (async () => {
      try {
        const ok = await loadBoard(currentId, 'open')
        if (cancelled) return
        // A board from an older version, or one that arrived damaged, is not
        // worth crashing over — start clean and say so.
        if (!ok) {
          useBoardStore.getState().initDefaultBoard()
          toast('That board could not be opened, so a fresh one is ready.')
        }
        loadedId.current = currentId
      } catch (err) {
        if (!cancelled) toast(toUserMessage(err, 'That board could not be opened.'))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [email, currentId])

  // 3. Write changes back, debounced.
  useEffect(() => {
    if (!email || !currentId) return

    let timer: number | null = null
    let warned = false

    const unsubscribe = useBoardStore.subscribe(() => {
      // A change that arrived from a peer is already theirs to save. Without
      // this, every client in a room writes the whole board on every remote op —
      // N clients fighting over one row, each overwriting the others with a
      // copy of what they just agreed on.
      if (isApplyingRemote()) return

      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(async () => {
        timer = null
        // Never write until this exact board has finished loading, or the
        // previous board's contents would overwrite the new one.
        if (loadedId.current !== currentId) return

        const boards = useBoardsStore.getState()
        const name = boards.boards.find((b) => b.id === currentId)?.name
        boards.setSaveState('saving')
        try {
          await api.saveBoard(currentId, name ?? 'My board', useBoardStore.getState().getPersistable())
          boards.touch(currentId)
          boards.setSaveState('saved')
          warned = false
        } catch (err) {
          // The indicator stays until a save succeeds; the toast fires once, so
          // a dropped server does not produce one per edit.
          boards.setSaveState('offline')
          if (!warned) {
            warned = true
            toast(toUserMessage(err, 'This board is not being saved right now.'))
          }
        }
      }, DEBOUNCE)
    })

    return () => {
      unsubscribe()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [email, currentId])
}
