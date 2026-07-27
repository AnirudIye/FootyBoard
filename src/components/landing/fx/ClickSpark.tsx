import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useReducedMotion } from '../../../hooks/useReducedMotion'

/** Lines in the burst, evenly spaced around the click. */
const COUNT = 8
const TRAVEL = 14 // px each line covers before it fades out
const DURATION = 520
const STAGGER = 12 // ms between neighbouring lines, so the ring unwinds

/**
 * Emits a short burst of ink lines from the pointer on click. A tactile,
 * on-brand acknowledgement rather than a neon ripple.
 *
 * Written against the Web Animations API directly. The elements being animated
 * are created here, imperatively, and never seen by React, so there is nothing
 * for a declarative animation library to hold on to; a dependency would only be
 * wrapping `Element.animate`, which every browser this app supports has had for
 * years.
 */
export function ClickSpark({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const host = ref.current
    if (!host || reduced) return

    const onClick = (e: MouseEvent) => {
      const rect = host.getBoundingClientRect()
      const layer = document.createElement('div')
      layer.style.cssText =
        `position:absolute;left:${e.clientX - rect.left}px;top:${e.clientY - rect.top}px;` +
        `pointer-events:none;z-index:5`
      host.appendChild(layer)

      let last: Animation | undefined
      for (let i = 0; i < COUNT; i++) {
        const spark = document.createElement('span')
        const angle = (360 / COUNT) * i
        spark.style.cssText =
          `position:absolute;left:0;top:0;width:2px;height:9px;border-radius:2px;` +
          `background:rgb(var(--accent));transform-origin:center`
        layer.appendChild(spark)
        // The rotation is part of every keyframe rather than a starting
        // transform, because a WAAPI transform keyframe replaces the whole
        // property rather than composing with what is already there.
        last = spark.animate(
          [
            { transform: `rotate(${angle}deg) translateY(0) scaleY(1)`, opacity: 1 },
            { transform: `rotate(${angle}deg) translateY(${-TRAVEL}px) scaleY(0.3)`, opacity: 0 },
          ],
          {
            duration: DURATION,
            delay: i * STAGGER,
            easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
            fill: 'forwards',
          },
        )
      }
      // The last line started last, so it also finishes last.
      if (last) last.onfinish = () => layer.remove()

      // Nudge the host itself for a tactile press.
      host.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.96)' }, { transform: 'scale(1)' }], {
        duration: 260,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      })
    }

    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
  }, [reduced])

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {children}
    </span>
  )
}
