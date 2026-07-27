import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * Close on a pointer press outside `ref`, or on Escape.
 *
 * The popover and the inspector each had their own identical copy of this, so
 * a fix to one silently missed the other.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
) {
  // Held in a ref so a caller passing an inline closure, which every caller
  // does, is not resubscribing both listeners on every render.
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, ref])
}
