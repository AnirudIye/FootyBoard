import { useEffect, useState } from 'react'

const QUERY = '(pointer: coarse)'

/**
 * Whether the pointer driving this session is a finger rather than a mouse.
 *
 * `src/index.css` already puts a 44px floor under every control in the app, on
 * exactly this media query and for exactly this reason. That rule cannot reach
 * the board: the pitch is a single `<canvas>`, so a cone is not an element, it
 * is paint, and no stylesheet has anything to say about how big it is to a
 * finger. Konva hit-tests the geometry it drew, which for a cone is a 22x25
 * triangle. Anything on the canvas a person has to hit therefore has to ask
 * this question itself and size its own target from the answer.
 *
 * The same shape as `useReducedMotion`, and for the same reason rather than out
 * of symmetry: the answer genuinely changes mid-session. A tablet gets a
 * trackpad plugged in, a laptop's touchscreen takes over from the trackpad, and
 * a target measured once at mount is then the wrong size until the page is
 * reloaded.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(QUERY)
    const onChange = () => setCoarse(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return coarse
}
