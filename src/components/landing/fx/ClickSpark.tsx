import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { animate, stagger, utils } from 'animejs'
import { useReducedMotion } from '../../../hooks/useReducedMotion'

/**
 * Emits a short burst of ink lines from the pointer on click, using anime.js.
 * A tactile, on-brand acknowledgement rather than a neon ripple.
 */
export function ClickSpark({
  children,
  color = 'rgb(var(--accent))',
  count = 8,
}: {
  children: ReactNode
  color?: string
  count?: number
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const host = ref.current
    if (!host || reduced) return

    const onClick = (e: MouseEvent) => {
      const rect = host.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const layer = document.createElement('div')
      layer.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;pointer-events:none;z-index:5`
      const sparks: HTMLElement[] = []
      for (let i = 0; i < count; i++) {
        const s = document.createElement('span')
        const angle = (360 / count) * i
        s.style.cssText =
          `position:absolute;left:0;top:0;width:2px;height:9px;border-radius:2px;` +
          `background:${color};transform-origin:center;transform:rotate(${angle}deg) translateY(0)`
        layer.appendChild(s)
        sparks.push(s)
      }
      host.appendChild(layer)

      animate(sparks, {
        translateY: [0, -14],
        opacity: [1, 0],
        scaleY: [1, 0.3],
        duration: 520,
        delay: stagger(12),
        ease: 'outExpo',
        onComplete: () => layer.remove(),
      })
      // Nudge the host itself for a tactile press.
      animate(host, { scale: [utils.get(host, 'scale') || 1, 0.96, 1], duration: 260, ease: 'outElastic(1, .6)' })
    }

    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
  }, [color, count, reduced])

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {children}
    </span>
  )
}
