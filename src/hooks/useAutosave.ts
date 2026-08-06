import { useEffect, useRef } from 'react'
import { useBoardStore, defaultPersistedBoard } from '../store/boardStore'
import { useAuthStore, selectSignedIn } from '../store/authStore'
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
    a.customFormations !== b.customFormations ||
    // A string, so this is a value comparison where the rest are reference ones.
    // It is the same test either way — "did `_snapshot()` change?" — and leaving
    // notes out of this list is precisely how a field gets written into every
    // save and never triggers one, which reads as a pad that forgets what you
    // typed unless you happened to move a chip afterwards.
    a.notes !== b.notes
  )
}

/**
 * Keeps the open board in step with the server.
 *
 * Two effects, deliberately separate: one owns which board is open, the other
 * owns saving it. Combining them would make every keystroke re-run the load.
 */
export function useAutosave() {
  // "Is there an account" rather than "is there an address". A guest admitted by
  // a join code has an account, real membership and boards that save, and no
  // address at all; gating on the address would have left them on an unsaved
  // board looking at somebody else's, which is the whole thing this fixed.
  const signedIn = useAuthStore(selectSignedIn)
  const ready = useAuthStore((s) => s.ready)
  const currentId = useBoardsStore((s) => s.currentId)

  // Guards the save subscription against writing a board that is still loading.
  const loadedId = useRef<string | null>(null)

  // Boards this version has already failed to read. Falling back to another
  // board is only safe if it cannot land on a second unreadable one: two of
  // them in the list and "open something else" is a loop, each turn of it a
  // request. Every failure adds an id and every candidate is drawn from what is
  // left, so there are at most as many hops as there are boards.
  const unreadable = useRef<Set<string>>(new Set())

  // 1. Signing in loads the board list; signing out clears it.
  useEffect(() => {
    if (!ready) return
    const boards = useBoardsStore.getState()

    if (!signedIn) {
      // Nobody signed in: a full board that is never written anywhere. Note this
      // is no longer what the product calls a guest — a guest admitted by a join
      // code has an account and lands in the branch below, with boards that save.
      // This is the signed-out visitor who just opened `/board`.
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
        // Built rather than reset-and-read for the same reason the picker does
        // it that way: nothing touches the open board until the new one exists.
        const newId = await boards.create('My board', defaultPersistedBoard())
        useBoardStore.getState().initDefaultBoard(newId)
      } catch (err) {
        if (!cancelled) toast(toUserMessage(err, 'Your boards could not be loaded.'))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [signedIn, ready])

  // 2. Opening a board — at sign-in or from the picker — pulls its contents.
  useEffect(() => {
    if (!signedIn || !currentId) return

    let cancelled = false
    loadedId.current = null

    void (async () => {
      try {
        const ok = await loadBoard(currentId, 'open')
        if (cancelled) return

        // A board from an older version, or one that arrived damaged, is not
        // worth crashing over.
        //
        // What must not happen is the stand-in being written back: the stored
        // record is unreadable by this version, not worthless, and a blank
        // board saved over it turns "we could not parse this" into "this is
        // gone" without anybody touching anything. So the stand-in carries no
        // board id and every write is refused.
        //
        // That is safe and, on its own, was still a dead end. A coach can work
        // on a refused board all afternoon: the toast saying so lasts four
        // seconds and the indicator read "Ready" for the rest of the session.
        // So prefer to move them somewhere that does save, which is what a
        // board id the server has never heard of already does, and only fall
        // back to the stand-in when there is nowhere to move them to.
        if (!ok) {
          unreadable.current.add(currentId)
          const boards = useBoardsStore.getState()
          const other = boards.boards.find((b) => !unreadable.current.has(b.id))

          if (other) {
            // Nothing is loaded over the top and nothing is blanked: `loadBoard`
            // left the store exactly as it found it, so selecting another board
            // simply loads that one instead. `loadedId` stays unset, which is
            // this effect's own signal that no board is open yet.
            boards.select(other.id)
            toast(
              `That board could not be opened, so "${other.name}" is open instead. Your saved copy is untouched.`,
            )
            return
          }

          // Nowhere to go. Say plainly that the copy on the server is being left
          // alone, because a coach looking at an empty pitch under their board's
          // name has every reason to assume the opposite, and leave the
          // indicator saying it for as long as it is true.
          useBoardStore.getState().initDefaultBoard()
          boards.setSaveState('blocked')
          toast('That board could not be opened. Your saved copy is untouched, and this blank one is not being saved.')
        } else if (useBoardsStore.getState().saveState === 'blocked') {
          // The condition has stopped being true: this board opened, so this
          // board saves. Only `blocked` is cleared, because every other state
          // describes a write rather than the board.
          useBoardsStore.getState().setSaveState('idle')
        }

        loadedId.current = currentId
      } catch (err) {
        if (cancelled) return
        // Never opened, so `loadedId` is never set for it and every write is
        // refused just as surely as above. The reason differs and the standing
        // truth does not, so the indicator says the same thing rather than
        // resting on "Ready" over a board that is going nowhere.
        toast(toUserMessage(err, 'That board could not be opened.'))
        useBoardsStore.getState().setSaveState('blocked')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [signedIn, currentId])

  // 3. Write changes back, debounced.
  useEffect(() => {
    if (!signedIn || !currentId) return

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
        //
        // A refused write is not a failed one. `flushSave` answers false when
        // the store is not holding this board, so there is nothing here that
        // belongs in it and nothing to tell anybody about.
        if (await flushSave(currentId)) warned = false
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
  }, [signedIn, currentId])
}
