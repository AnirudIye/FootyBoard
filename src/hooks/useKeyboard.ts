import { useEffect } from 'react'
import { useBoardStore } from '../store/boardStore'
import { useRealtimeStore } from '../store/realtimeStore'

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

/**
 * Shortcuts that change the board, as opposed to changing what you are looking
 * at. These are the ones the editing lock withholds; selecting and deselecting
 * stay available, because looking is not editing.
 */
const isEditingShortcut = (e: KeyboardEvent): boolean => {
  const mod = e.ctrlKey || e.metaKey
  if (mod && (e.code === 'KeyZ' || e.code === 'KeyY' || e.code === 'KeyD')) return true
  if (e.code === 'Delete' || e.code === 'Backspace') return true
  return e.code.startsWith('Arrow')
}

/** Global board shortcuts: undo/redo, duplicate, delete, nudge, deselect. */
export function useKeyboard() {
  useEffect(() => {
    let nudged = false

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      // The server drops a locked member's edits anyway; stopping them here
      // means the board does not briefly show a change that is about to be
      // undone by the next message from anyone else.
      if (useRealtimeStore.getState().locked && isEditingShortcut(e)) return
      const st = useBoardStore.getState()
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) st.redoAction()
        else st.undoAction()
        return
      }
      if (mod && e.code === 'KeyY') {
        e.preventDefault()
        st.redoAction()
        return
      }
      if (mod && e.code === 'KeyD') {
        e.preventDefault()
        st.duplicateSelection()
        return
      }
      if (mod && e.code === 'KeyA') {
        e.preventDefault()
        st.setSelection(st.tokens.map((t) => t.id))
        return
      }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        if (st.selection.length === 0) return
        e.preventDefault()
        st.deleteSelection()
        return
      }
      if (e.code === 'Escape') {
        st.clearSelection()
        return
      }

      const step = e.shiftKey ? 2 : 0.5
      let dx = 0
      let dy = 0
      if (e.code === 'ArrowLeft') dx = -step
      else if (e.code === 'ArrowRight') dx = step
      else if (e.code === 'ArrowUp') dy = -step
      else if (e.code === 'ArrowDown') dy = step
      else return

      if (st.selection.length === 0) return
      e.preventDefault()
      st.moveTokens(st.selection, dx, dy)
      nudged = true
    }

    // Commit once the nudge gesture ends so a held arrow key is one undo step.
    const onKeyUp = (e: KeyboardEvent) => {
      if (!nudged) return
      if (e.code.startsWith('Arrow')) {
        useBoardStore.getState().commit()
        nudged = false
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])
}
