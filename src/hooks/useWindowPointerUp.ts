import { useEffect, useRef } from 'react'

/**
 * Run a gesture teardown when the pointer is released, wherever it is released.
 *
 * Konva binds a stage's pointer events to `stage.content` and to nothing else,
 * with no window or document fallback, so a gesture that starts on the canvas
 * and ends anywhere else never reaches the stage's `onPointerUp`. Konva's node
 * drag system *does* bind on `window`, which is why dragging a chip off the
 * canvas still ends cleanly and why the marquee, the pan and the draw gesture
 * did not: those three hang off the stage handler alone.
 *
 * That is easy to hit rather than exotic, because the overlays are siblings of
 * the canvas and not children of it. The bench rails sit on both touchlines,
 * the HUD in a corner, and the toolbars above and below, so releasing a pen
 * stroke over the home bench discarded the drawing, a marquee released over the
 * toolbar kept resizing with no button held, and a pan released over the frame
 * strip kept translating the board.
 *
 * `pointercancel` is here too: the browser takes a pointer away on its own for
 * a scroll gesture or a system interruption, and an abandoned gesture has to be
 * torn down exactly like a finished one.
 *
 * The callback is read through a ref rather than depended on, because a pen
 * stroke rebuilds it on every pointermove and the listener should not be torn
 * down and rebuilt that often.
 */
export function useWindowPointerUp(onUp: () => void): void {
  const latest = useRef(onUp)
  latest.current = onUp

  useEffect(() => {
    const handle = () => latest.current()
    window.addEventListener('pointerup', handle)
    window.addEventListener('pointercancel', handle)
    return () => {
      window.removeEventListener('pointerup', handle)
      window.removeEventListener('pointercancel', handle)
    }
  }, [])
}
