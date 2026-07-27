import { useEffect, useRef } from 'react'
import { useBoardStore } from '../store/boardStore'
import { useAuthStore } from '../store/authStore'
import { useBoardsStore } from '../store/boardsStore'
import { loadBoard, flushSave } from '../lib/boardSync'
import { isApplyingRemote } from '../lib/realtime/bridge'
import { toUserMessage } from '../lib/errors'
import { toast } from '../store/toastStore'

const DEBOUNCE = 800
/** How many debounce beats a pending save will wait for the board to load. */
const MAX_LOAD_WAITS = 10

type BoardState = ReturnType<typeof useBoardStore.getState>

/**
 * The fields `_snapshot()` actually writes.
 *
 * The board store also holds a pile of state that is nobody's business but this
 * browser's: the selection, the zoom, the current tool, the inspector, the
 * playhead. Subscribing to the store as a whole meant scrubbing playback queued
 * a full clone, serialise and PUT of the entire board every 800ms for the
 * length of the sequence, and in a room that churned `updated_at` and reordered
 * everyone's board picker while somebody simply watched a move play.
 *
 * Every action that changes one of these replaces the array or object outright,
 * so reference equality is the whole test.
 */
function persistableChanged(a: BoardState, b: BoardState): boolean {
  return (
    a.teams !== b.teams ||
    a.tokens !== b.tokens ||
    a.bench !== b.bench ||
    a.drawings !== b.drawings ||
    a.frames !== b.frames ||
    a.view !== b.view ||
    a.customFormations !== b.customFormations
  )
}

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
    let waits = 0

    const save = async () => {
      timer = null
      // Never write until this exact board has finished loading, or the
      // previous board's contents would overwrite the new one. An edit made
      // during that window is still a real edit, though, so wait another beat
      // rather than returning: dropping it silently left the indicator reading
      // "Saved" over work that had never been written anywhere.
      //
      // Bounded, because a load that failed outright never sets loadedId, and
      // an unbounded rearm would leave a timer going round for the life of the
      // page. Ten beats is far longer than a load takes and short of forever.
      if (loadedId.current !== currentId) {
        if (waits >= MAX_LOAD_WAITS) return
        waits += 1
        timer = window.setTimeout(save, DEBOUNCE)
        return
      }

      try {
        // The same write the realtime hook performs, not a second copy of it:
        // two implementations of "save this board" meant every change to what
        // saving means had to be made twice, and once was missed.
        await flushSave(currentId)
        warned = false
      } catch (err) {
        // flushSave has already set the indicator, and it stays until a save
        // succeeds. The toast fires once, so a dropped server does not
        // produce one per edit.
        if (!warned) {
          warned = true
          toast(toUserMessage(err, 'This board is not being saved right now.'))
        }
      }
    }

    const unsubscribe = useBoardStore.subscribe((state, prev) => {
      // A change that arrived from a peer is already theirs to save. Without
      // this, every client in a room writes the whole board on every remote op —
      // N clients fighting over one row, each overwriting the others with a
      // copy of what they just agreed on.
      if (isApplyingRemote()) return
      if (!persistableChanged(state, prev)) return

      if (timer !== null) window.clearTimeout(timer)
      waits = 0
      timer = window.setTimeout(save, DEBOUNCE)
    })

    return () => {
      unsubscribe()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [email, currentId])
}
