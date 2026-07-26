import { useEffect, useRef, useState } from 'react'
import { animate } from 'framer-motion'
import type { PitchMapping } from '../components/board/pitchMapping'
import { blendMappings } from '../components/board/pitchMapping'
import { useReducedMotion } from './useReducedMotion'

const DURATION = 0.5 // seconds

/**
 * Smoothly morphs from the previously shown pitch geometry to the target
 * whenever the view or kind changes. The key subtlety: the morph must start
 * from what is *currently on screen*, so on the render where the shape changes
 * we must NOT adopt the new target as the displayed value — we keep showing the
 * old geometry and let the animation blend toward the target. Size-only changes
 * (a continuous ResizeObserver stream) are applied immediately so dragging a
 * window edge stays responsive.
 */
export function useAnimatedMapping(target: PitchMapping): PitchMapping {
  const reduced = useReducedMotion()
  const [, force] = useState(0)

  // One stable mutable record for the whole morph lifecycle.
  const s = useRef({
    shapeKey: `${target.view}|${target.kind}`,
    current: target,
    from: target,
    to: target,
    animating: false,
  }).current

  const shapeKey = `${target.view}|${target.kind}`

  if (shapeKey !== s.shapeKey) {
    // Shape changed on this render: begin morphing from what is on screen now.
    s.shapeKey = shapeKey
    s.to = target
    if (reduced) {
      s.current = target
      s.animating = false
    } else {
      s.from = s.current
      s.animating = true
    }
  } else if (!s.animating) {
    // Stable: follow the target exactly (keeps resize responsive).
    s.current = target
    s.to = target
  } else {
    // Mid-morph: keep the destination fresh if the size changed underneath us.
    s.to = target
  }

  useEffect(() => {
    if (!s.animating) return
    const controls = animate(0, 1, {
      duration: DURATION,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (p) => {
        s.current = blendMappings(s.from, s.to, p)
        force((n) => n + 1)
      },
      onComplete: () => {
        s.current = s.to
        s.animating = false
        force((n) => n + 1)
      },
    })
    return () => controls.stop()
    // Restart the morph whenever the shape changes; force-updates during the
    // morph keep shapeKey stable so this does not re-fire mid-animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey])

  return s.current
}
